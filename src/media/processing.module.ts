import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { GcsModule } from '../gcs/gcs.module';
import { DlqModule } from '../dlq/dlq.module';
import { MediaAsset } from './media-asset.entity';
import { AssetUploadService } from './asset-upload.service';
import { ImageConversionService } from './image-conversion.service';
import { VideoTranscodeProcessor } from './video-transcode.processor';
import { VIDEO_TRANSCODE_QUEUE } from './video-transcode.constants';

/**
 * The entire compression/conversion pipeline. This is the ONLY module that
 * touches Redis job data and ffmpeg/sharp — everything else in this app
 * (health checks) exists just to let Kubernetes supervise this module safely.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MediaAsset]),
    BullModule.registerQueue({ name: VIDEO_TRANSCODE_QUEUE }),
    GcsModule,
    DlqModule,
  ],
  providers: [AssetUploadService, ImageConversionService, VideoTranscodeProcessor],
  // Re-export the Queue provider so HealthController (in AppModule) can read
  // queue/connection state for /readyz without duplicating the registration.
  exports: [BullModule],
})
export class ProcessingModule {}
