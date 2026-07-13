import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GcsService } from '../gcs/gcs.service';
import { MediaAsset } from './media-asset.entity';
import { AssetUploadService, buildConvertedFilename, getMediaKind } from './asset-upload.service';
import { ImageConvertFormat } from './video-transcode.constants';

// sharp ships ESM-style typings but a callable CJS export; with esModuleInterop
// off, a default import would emit `.default` (undefined at runtime).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp') as typeof import('sharp').default;
// Runs alongside ffmpeg in the same pod — capped so a heavy AVIF encode can't
// alone claim every core the deployment's CPU limit allows.
sharp.concurrency(Number(process.env.SHARP_CONCURRENCY ?? 1));

const IMAGE_FORMAT_MIMES: Record<Exclude<ImageConvertFormat, 'original'>, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png:  'image/png',
};

const clampQuality = (q: number) => Math.min(100, Math.max(10, Math.round(q)));

/** Handles CONVERT_IMAGE_JOB — the sharp/libvips half of the pipeline. */
@Injectable()
export class ImageConversionService {
  private readonly logger = new Logger(ImageConversionService.name);

  constructor(
    @InjectRepository(MediaAsset) private readonly assetRepo: Repository<MediaAsset>,
    private readonly gcs: GcsService,
    private readonly uploads: AssetUploadService,
  ) {}

  async convert(assetId: string, format: ImageConvertFormat, quality: number): Promise<void> {
    const asset = await this.assetRepo.findOne({ where: { id: assetId } });
    if (!asset || getMediaKind(asset.mimeType) !== 'image') {
      this.logger.warn(`Image convert skipped — asset ${assetId} missing or not an image`);
      return;
    }

    const q = clampQuality(quality);
    const sourceExt = asset.mimeType.split('/')[1]?.replace('jpg', 'jpeg');
    const targetFormat = format === 'original'
      ? (sourceExt as Exclude<ImageConvertFormat, 'original'>)
      : format;
    if (!IMAGE_FORMAT_MIMES[targetFormat]) {
      throw new Error(`Unsupported source format for re-encode: ${asset.mimeType}`);
    }

    const source = await this.gcs.download(asset.storageKey);

    let pipeline = sharp(source).rotate(); // bake EXIF orientation in
    switch (targetFormat) {
      case 'webp': pipeline = pipeline.webp({ quality: q }); break;
      case 'avif': pipeline = pipeline.avif({ quality: q }); break;
      // JPEG has no alpha — flatten transparency onto white
      case 'jpeg': pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: q, mozjpeg: true }); break;
      case 'png':  pipeline = pipeline.png({ quality: q, palette: true }); break;
    }
    const output = await pipeline.toBuffer();

    const ext = targetFormat === 'jpeg' ? 'jpg' : targetFormat;
    const filename = buildConvertedFilename(asset.originalFilename, ext, q, targetFormat !== sourceExt);

    const created = await this.uploads.saveProcessedAsset(
      { buffer: output, originalFilename: filename, mimeType: IMAGE_FORMAT_MIMES[targetFormat] },
      { altText: asset.altText, uploadedBy: asset.uploadedBy, folderId: asset.folderId },
    );
    this.logger.log(`Image convert done: ${asset.originalFilename} → ${created.originalFilename} (${(created.sizeBytes / 1024).toFixed(0)} KB)`);
  }
}
