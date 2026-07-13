import { Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import ffmpeg = require('fluent-ffmpeg');
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import { DlqAwareWorker } from '../dlq/dlq-aware.worker';
import { DlqService } from '../dlq/dlq.service';
import { GcsService } from '../gcs/gcs.service';
import { MetricsService } from '../metrics/metrics.service';
import { MediaAsset } from './media-asset.entity';
import { AssetUploadService, buildConvertedFilename } from './asset-upload.service';
import { ImageConversionService } from './image-conversion.service';
import { JobProgressReporter } from './job-progress';
import {
  CONVERT_IMAGE_JOB, CONVERT_VIDEO_JOB, ConvertImageJobData, ConvertVideoJobData,
  TranscodeJobData, VIDEO_TRANSCODE_QUEUE,
} from './video-transcode.constants';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

/** ffmpeg CPU budget for this pod (500m/0.5 core by default — see docker/k8s/asset-worker-deployment.yaml). */
const FFMPEG_THREADS  = process.env.FFMPEG_THREADS ?? '1';
const FFMPEG_NICENESS = Number(process.env.FFMPEG_NICENESS ?? 10);
/** ffmpeg spawned through `nice` so a burst can never starve this pod's own health/metrics loop. */
const niceFfmpeg = (input: string) => ffmpeg(input, { niceness: FFMPEG_NICENESS });

/** Quality ladder — rungs above the source height are skipped. */
const HLS_RUNGS = [
  { height: 1080, videoBitrate: '5000k', maxrate: '5350k', bufsize: '7500k', audioBitrate: '128k' },
  { height: 720,  videoBitrate: '2800k', maxrate: '2996k', bufsize: '4200k', audioBitrate: '128k' },
  { height: 480,  videoBitrate: '1200k', maxrate: '1284k', bufsize: '1800k', audioBitrate: '96k'  },
] as const;

const SEGMENT_SECONDS = 4;

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s':  'video/iso.segment',
  '.mp4':  'video/mp4',
  '.jpg':  'image/jpeg',
};

/**
 * Sole consumer of the `video-transcode` queue: HLS transcoding on upload,
 * video format/quality conversion, and (routed to ImageConversionService)
 * image conversion. Runs in this dedicated pod only — the API never runs
 * this processor (see back/src/media/media.module.ts, producer-only).
 */
@Processor(VIDEO_TRANSCODE_QUEUE, {
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
  // ffmpeg jobs run for many minutes on large uploads; a long lock keeps the
  // job owned even if CPU pressure delays the periodic lock renewal.
  lockDuration: 10 * 60_000,
})
export class VideoTranscodeProcessor extends DlqAwareWorker {
  protected readonly queueName = VIDEO_TRANSCODE_QUEUE;
  private readonly logger = new Logger(VideoTranscodeProcessor.name);

  constructor(
    dlqService: DlqService,
    @InjectRepository(MediaAsset) private readonly assetRepo: Repository<MediaAsset>,
    private readonly gcs: GcsService,
    private readonly uploads: AssetUploadService,
    private readonly imageConversion: ImageConversionService,
    private readonly metrics: MetricsService,
  ) {
    super(dlqService);
  }

  /**
   * Duration/outcome logging + Prometheus metrics for every job type in one
   * place — structured log fields (jobId, jobName, assetId, durationMs) so
   * `kubectl logs` is greppable, and the same data feeds /metrics
   * (asset_worker_job_duration_seconds, asset_worker_jobs_total,
   * asset_worker_active_jobs) for when a scraper is added.
   */
  async process(job: Job): Promise<void> {
    const startedAt = Date.now();
    const assetId = (job.data as { assetId?: string }).assetId;
    this.metrics.activeJobs.inc();
    this.logger.log({ msg: 'job started', jobId: job.id, jobName: job.name, assetId });
    try {
      await this.dispatch(job);
      const durationMs = Date.now() - startedAt;
      this.logger.log({ msg: 'job completed', jobId: job.id, jobName: job.name, assetId, durationMs });
      this.metrics.jobsTotal.inc({ jobName: job.name, outcome: 'success' });
      this.metrics.jobDurationSeconds.observe({ jobName: job.name }, durationMs / 1000);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.logger.error({ msg: 'job failed', jobId: job.id, jobName: job.name, assetId, durationMs, error: (err as Error).message });
      this.metrics.jobsTotal.inc({ jobName: job.name, outcome: 'failure' });
      this.metrics.jobDurationSeconds.observe({ jobName: job.name }, durationMs / 1000);
      throw err; // preserve BullMQ retry/DLQ behavior — DlqAwareWorker still handles this
    } finally {
      this.metrics.activeJobs.dec();
    }
  }

  private dispatch(job: Job): Promise<void> {
    if (job.name === CONVERT_VIDEO_JOB) return this.handleConvert(job as Job<ConvertVideoJobData>);
    if (job.name === CONVERT_IMAGE_JOB) {
      const { assetId, format, quality } = (job as Job<ConvertImageJobData>).data;
      return this.imageConversion.convert(assetId, format, quality);
    }
    return this.handleTranscode(job as Job<TranscodeJobData>);
  }

  /** Format/quality conversion → uploads the result as a NEW media asset. */
  private async handleConvert(job: Job<ConvertVideoJobData>): Promise<void> {
    const { assetId, format, quality } = job.data;
    const asset = await this.assetRepo.findOne({ where: { id: assetId } });
    if (!asset || !asset.mimeType.startsWith('video/')) {
      this.logger.warn(`Convert skipped — asset ${assetId} missing or not a video`);
      return;
    }

    const sourceExt = asset.mimeType === 'video/webm' ? 'webm' : 'mp4';
    const targetExt = format === 'original' ? sourceExt : format;
    // Scoped-per-job temp dir with guaranteed cleanup, even on failure.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `job-${job.id}-`));
    const progress = new JobProgressReporter(job);

    try {
      const sourcePath = path.join(tmpDir, `source.${sourceExt}`);
      await this.gcs.downloadToFile(asset.storageKey, sourcePath);
      const { hasAudio } = await probe(sourcePath);

      const outPath = path.join(tmpDir, `out.${targetExt}`);
      // quality 100 → visually lossless, 10 → smallest file
      const ratio = (100 - quality) / 90;
      const command = niceFfmpeg(sourcePath);
      if (targetExt === 'webm') {
        const crf = Math.round(24 + ratio * 26); // 24…50
        command
          .videoCodec('libvpx-vp9')
          .outputOptions([
            '-b:v', '0', '-crf', String(crf), '-row-mt', '1', '-threads', FFMPEG_THREADS,
            ...(hasAudio ? ['-c:a', 'libopus', '-b:a', '96k'] : ['-an']),
          ]);
      } else {
        const crf = Math.round(18 + ratio * 20); // 18…38
        command
          .videoCodec('libx264')
          .outputOptions([
            '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', FFMPEG_THREADS,
            ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
            '-movflags', '+faststart',
          ]);
      }
      await runFfmpeg(command.output(outPath), percent => progress.report(percent));

      const filename = buildConvertedFilename(asset.originalFilename, targetExt, quality, targetExt !== sourceExt);
      const { size: sizeBytes } = await fs.stat(outPath);

      // Streamed from disk — never buffers the (potentially 100MB+) output
      // into memory. See AssetUploadService.saveProcessedVideoFile.
      const created = await this.uploads.saveProcessedVideoFile(
        outPath,
        { originalFilename: filename, mimeType: targetExt === 'webm' ? 'video/webm' : 'video/mp4', sizeBytes },
        { altText: asset.altText, uploadedBy: asset.uploadedBy, folderId: asset.folderId },
      );
      this.logger.log(`Video convert done: ${asset.originalFilename} → ${created.originalFilename} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  /** Auto-transcode on upload: HLS ladder + optimized MP4 fallback + poster. */
  private async handleTranscode(job: Job<TranscodeJobData>): Promise<void> {
    const asset = await this.assetRepo.findOne({ where: { id: job.data.assetId } });
    if (!asset) {
      this.logger.warn(`Transcode skipped — asset ${job.data.assetId} not found`);
      return;
    }
    if (!asset.mimeType.startsWith('video/')) {
      this.logger.warn(`Transcode skipped — asset ${asset.id} is not a video (${asset.mimeType})`);
      return;
    }

    // Resumability: if a previous attempt crashed mid-way, this simply
    // overwrites the same GCS keys and re-sets the same status — no
    // partial/duplicate state can accumulate from a retry.
    await this.assetRepo.update(asset.id, { transcodeStatus: 'processing' });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `job-${job.id}-`));
    const progress = new JobProgressReporter(job);

    try {
      const sourcePath = path.join(tmpDir, `source${path.extname(asset.storageKey) || '.mp4'}`);
      await this.gcs.downloadToFile(asset.storageKey, sourcePath);

      const { width, height, duration, hasAudio } = await probe(sourcePath);
      this.logger.log(`Transcoding asset ${asset.id}: ${width}x${height}, ${duration.toFixed(1)}s`);

      const rungs = HLS_RUNGS.filter(r => r.height <= height);
      if (rungs.length === 0) rungs.push(HLS_RUNGS[HLS_RUNGS.length - 1]);

      const outDir = path.join(tmpDir, 'out');
      await fs.mkdir(outDir);

      // Weighted equally across stages — see JobProgressReporter.reportStage.
      const totalStages = rungs.length + 1; // + MP4 fallback (poster is near-instant, not counted)

      for (const [i, rung] of rungs.entries()) {
        await this.encodeHlsRendition(sourcePath, outDir, rung, hasAudio,
          percent => progress.reportStage(i, totalStages, percent));
      }
      const masterName = 'master.m3u8';
      await fs.writeFile(path.join(outDir, masterName), buildMasterPlaylist(rungs, width, height), 'utf8');

      const mp4Name = 'fallback.mp4';
      await this.encodeMp4Fallback(sourcePath, path.join(outDir, mp4Name), Math.min(height, 720), hasAudio,
        percent => progress.reportStage(rungs.length, totalStages, percent));

      const posterName = 'poster.jpg';
      await extractPoster(sourcePath, outDir, posterName, Math.min(duration / 2, 1));

      const keyPrefix = `media/hls/${asset.id}`;
      const files = await fs.readdir(outDir);
      for (const file of files) {
        const contentType = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
        await this.gcs.uploadFromFile(path.join(outDir, file), `${keyPrefix}/${file}`, contentType, 'publicRead');
      }

      await this.assetRepo.update(asset.id, {
        hlsKey:          `${keyPrefix}/${masterName}`,
        mp4Key:          `${keyPrefix}/${mp4Name}`,
        autoPosterKey:   `${keyPrefix}/${posterName}`,
        transcodeStatus: 'ready',
        ...(asset.width == null ? { width } : {}),
        ...(asset.height == null ? { height } : {}),
        ...(asset.durationSeconds == null ? { durationSeconds: Math.round(duration) } : {}),
      });
      this.logger.log(`Transcode ready for asset ${asset.id} (${rungs.length} rendition(s))`);
    } catch (err) {
      await this.assetRepo.update(asset.id, { transcodeStatus: 'failed' });
      throw err;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private encodeHlsRendition(
    sourcePath: string,
    outDir: string,
    rung: (typeof HLS_RUNGS)[number],
    hasAudio: boolean,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    const name = `${rung.height}p`;
    return runFfmpeg(
      niceFfmpeg(sourcePath)
        .videoCodec('libx264')
        .outputOptions([
          '-preset', 'medium',
          '-profile:v', 'main',
          '-threads', FFMPEG_THREADS,
          '-vf', `scale=-2:${rung.height}`,
          '-b:v', rung.videoBitrate,
          '-maxrate', rung.maxrate,
          '-bufsize', rung.bufsize,
          '-g', String(SEGMENT_SECONDS * 30),
          '-keyint_min', String(SEGMENT_SECONDS * 30),
          '-sc_threshold', '0',
          ...(hasAudio ? ['-c:a', 'aac', '-b:a', rung.audioBitrate, '-ac', '2'] : ['-an']),
          '-hls_time', String(SEGMENT_SECONDS),
          '-hls_playlist_type', 'vod',
          '-hls_segment_type', 'fmp4',
          '-hls_fmp4_init_filename', `${name}_init.mp4`,
          '-hls_segment_filename', path.join(outDir, `${name}_%03d.m4s`),
        ])
        .output(path.join(outDir, `${name}.m3u8`)),
      onProgress,
    );
  }

  private encodeMp4Fallback(
    sourcePath: string,
    outPath: string,
    height: number,
    hasAudio: boolean,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    return runFfmpeg(
      niceFfmpeg(sourcePath)
        .videoCodec('libx264')
        .outputOptions([
          '-preset', 'medium',
          '-profile:v', 'main',
          '-threads', FFMPEG_THREADS,
          '-vf', `scale=-2:${height}`,
          '-crf', '23',
          '-maxrate', '3000k',
          '-bufsize', '4500k',
          ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
          '-movflags', '+faststart',
        ])
        .output(outPath),
      onProgress,
    );
  }
}

// ── ffmpeg helpers (pure, promise wrappers) ──────────────────────────────────

function runFfmpeg(command: ffmpeg.FfmpegCommand, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (onProgress) {
      // fluent-ffmpeg parses ffmpeg's stderr `time=` output against the
      // probed duration; `percent` can be missing on the very first tick
      // (before duration is known) or drift slightly past 100 near the end
      // — the caller (JobProgressReporter) clamps, so pass raw values through.
      command.on('progress', (data: { percent?: number }) => {
        if (typeof data.percent === 'number') onProgress(data.percent);
      });
    }
    command
      .on('error', (err: Error, _stdout: string, stderr: string) =>
        reject(new Error(`ffmpeg failed: ${err.message}\n${(stderr ?? '').slice(-2000)}`)))
      .on('end', () => {
        onProgress?.(100);
        resolve();
      })
      .run();
  });
}

function probe(sourcePath: string): Promise<{ width: number; height: number; duration: number; hasAudio: boolean }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(sourcePath, (err, data) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
      const video = data.streams.find(s => s.codec_type === 'video');
      if (!video?.width || !video?.height) return reject(new Error('No decodable video stream found'));
      resolve({
        width:    video.width,
        height:   video.height,
        duration: Number(data.format?.duration ?? video.duration ?? 0),
        hasAudio: data.streams.some(s => s.codec_type === 'audio'),
      });
    });
  });
}

function extractPoster(sourcePath: string, outDir: string, filename: string, atSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath, { niceness: FFMPEG_NICENESS })
      .on('error', (err: Error) => reject(new Error(`poster extraction failed: ${err.message}`)))
      .on('end', () => resolve())
      .screenshots({
        timestamps: [Math.max(atSeconds, 0)],
        filename,
        folder: outDir,
        size: '1280x?',
      });
  });
}

function buildMasterPlaylist(
  rungs: ReadonlyArray<(typeof HLS_RUNGS)[number]>,
  sourceWidth: number,
  sourceHeight: number,
): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
  for (const rung of rungs) {
    const width = Math.round((sourceWidth / sourceHeight) * rung.height / 2) * 2;
    const bandwidth = Math.round(
      (parseInt(rung.videoBitrate, 10) + parseInt(rung.audioBitrate, 10)) * 1000 * 1.1,
    );
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${rung.height},CODECS="avc1.4d401f,mp4a.40.2"`,
      `${rung.height}p.m3u8`,
    );
  }
  return lines.join('\n') + '\n';
}
