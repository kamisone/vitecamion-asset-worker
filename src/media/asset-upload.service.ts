import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { Repository } from 'typeorm';
import { GcsService } from '../gcs/gcs.service';
import { MediaAsset } from './media-asset.entity';
import { extractImageDimensions, extractVideoMetadata } from './media-metadata.util';
import { TRANSCODE_JOB, TranscodeJobData, VIDEO_TRANSCODE_QUEUE } from './video-transcode.constants';

/** Enough to cover the moov/mvhd atom in a +faststart MP4 without reading the whole file. */
const METADATA_SNIFF_BYTES = 4 * 1024 * 1024;

export type MediaKind = 'image' | 'video' | 'other';

export function getMediaKind(mimeType: string): MediaKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'other';
}

/** "photo.jpg" + webp/q75 → "photo-webp-q75.webp"; same-format → "photo-q75.jpg" */
export function buildConvertedFilename(original: string, targetExt: string, quality: number, formatChanged: boolean): string {
  const base = original.replace(/\.[^.]+$/, '') || original;
  return formatChanged
    ? `${base}-${targetExt}-q${quality}.${targetExt}`
    : `${base}-q${quality}.${targetExt}`;
}

export interface ProcessedFile {
  buffer: Buffer;
  originalFilename: string;
  mimeType: string;
}

const MEDIA_PREFIX = 'media/';

/**
 * Persists a processing OUTPUT (a converted image or video) as a brand-new
 * media asset — exactly the same checksum-dedup + GCS-write + row-insert
 * logic as back's MediaService.upload(), trimmed of the two things only the
 * API needs: HEIC/MOV normalization (inputs here are already produced by our
 * own ffmpeg/sharp pipeline, never raw camera formats) and signed-URL
 * resolution (asset-worker never serves URLs, only writes rows; the API
 * resolves URLs on read).
 *
 * Idempotent by design: re-running the same conversion produces identical
 * bytes → identical checksum → the existing row is returned instead of a
 * duplicate, so a retried BullMQ job can never create duplicate assets.
 */
@Injectable()
export class AssetUploadService {
  private readonly logger = new Logger(AssetUploadService.name);

  constructor(
    @InjectRepository(MediaAsset) private readonly assetRepo: Repository<MediaAsset>,
    private readonly gcs: GcsService,
    @InjectQueue(VIDEO_TRANSCODE_QUEUE) private readonly transcodeQueue: Queue<TranscodeJobData>,
  ) {}

  async saveProcessedAsset(
    file: ProcessedFile,
    opts: { altText?: string | null; uploadedBy?: string | null; folderId?: string | null } = {},
  ): Promise<MediaAsset> {
    const kind = getMediaKind(file.mimeType);
    const checksum = crypto.createHash('sha256').update(new Uint8Array(file.buffer)).digest('hex');

    const existing = await this.assetRepo.findOne({ where: { checksum } });
    if (existing) {
      this.logger.log(`Dedup hit for ${file.originalFilename} → reusing asset ${existing.id}`);
      return existing;
    }

    const ext        = file.originalFilename.split('.').pop()?.toLowerCase() ?? 'bin';
    const datePart   = new Date().toISOString().slice(0, 7);
    const storageKey = `${MEDIA_PREFIX}${datePart}/${checksum.slice(0, 8)}-${Date.now()}.${ext}`;

    await this.gcs.upload(file.buffer, storageKey, file.mimeType, 'publicRead');

    const { width, height, durationSeconds } = kind === 'video'
      ? await extractVideoMetadata(file.buffer, file.mimeType)
      : { ...(await extractImageDimensions(file.buffer, file.mimeType)), durationSeconds: null };

    const asset = this.assetRepo.create({
      storageKey,
      originalFilename: file.originalFilename,
      mimeType:         file.mimeType,
      sizeBytes:        file.buffer.length,
      width,
      height,
      durationSeconds,
      altText:          opts.altText ?? null,
      checksum,
      uploadedBy:       opts.uploadedBy ?? null,
      folderId:         opts.folderId ?? null,
      tags:             [],
      transcodeStatus:  kind === 'video' ? 'pending' : null,
    });
    await this.assetRepo.save(asset);

    // A converted video is itself a new video asset — it gets its own HLS
    // ladder, same as any freshly uploaded video.
    if (kind === 'video') {
      await this.transcodeQueue.add(TRANSCODE_JOB, { assetId: asset.id }, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: false,
      });
    }

    return asset;
  }

  /**
   * Same as saveProcessedAsset, but for a file already on disk instead of a
   * Buffer — used for video conversion outputs, which can be well over
   * 100MB. Never loads the full file into memory: the checksum is computed
   * via a streamed hash, the GCS upload streams directly from disk
   * (GcsService.uploadFromFile), and metadata is read from just the first
   * few MB (sufficient for the moov/mvhd atom since our outputs always set
   * -movflags +faststart, which places it at the start of the file).
   */
  async saveProcessedVideoFile(
    filePath: string,
    meta: { originalFilename: string; mimeType: string; sizeBytes: number },
    opts: { altText?: string | null; uploadedBy?: string | null; folderId?: string | null } = {},
  ): Promise<MediaAsset> {
    const checksum = await this.hashFile(filePath);

    const existing = await this.assetRepo.findOne({ where: { checksum } });
    if (existing) {
      this.logger.log(`Dedup hit for ${meta.originalFilename} → reusing asset ${existing.id}`);
      return existing;
    }

    const ext        = meta.originalFilename.split('.').pop()?.toLowerCase() ?? 'bin';
    const datePart    = new Date().toISOString().slice(0, 7);
    const storageKey  = `${MEDIA_PREFIX}${datePart}/${checksum.slice(0, 8)}-${Date.now()}.${ext}`;

    await this.gcs.uploadFromFile(filePath, storageKey, meta.mimeType, 'publicRead');

    const head = await this.readHead(filePath, METADATA_SNIFF_BYTES);
    const { width, height, durationSeconds } = await extractVideoMetadata(head, meta.mimeType);

    const asset = this.assetRepo.create({
      storageKey,
      originalFilename: meta.originalFilename,
      mimeType:         meta.mimeType,
      sizeBytes:        meta.sizeBytes,
      width,
      height,
      durationSeconds,
      altText:          opts.altText ?? null,
      checksum,
      uploadedBy:       opts.uploadedBy ?? null,
      folderId:         opts.folderId ?? null,
      tags:             [],
      transcodeStatus:  'pending',
    });
    await this.assetRepo.save(asset);

    await this.transcodeQueue.add(TRANSCODE_JOB, { assetId: asset.id }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    return asset;
  }

  private async hashFile(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await pipeline(createReadStream(filePath), hash);
    return hash.digest('hex');
  }

  private async readHead(filePath: string, bytes: number): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}
