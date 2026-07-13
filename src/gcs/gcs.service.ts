import { Injectable, Logger } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';

/**
 * Mirrors back/src/gcs/gcs.service.ts — same bucket, same credentials, same
 * object layout. Kept as a separate copy (no shared package between the two
 * services yet); if one changes, update the other.
 */
@Injectable()
export class GcsService {
  private readonly logger = new Logger(GcsService.name);
  private readonly storage: Storage;
  private readonly bucketName = process.env.GCS_BUCKET_NAME!;

  constructor() {
    this.storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: {
        client_email: process.env.GCS_CLIENT_EMAIL,
        private_key: process.env.GCS_PRIVATE_KEY!.replace(/\\n/g, '\n'),
        private_key_id: process.env.GCS_PRIVATE_KEY_ID,
      },
    });
  }

  async upload(
    buffer: Buffer,
    objectName: string,
    contentType: string,
    predefinedAcl?: 'publicRead' | 'private',
  ): Promise<void> {
    try {
      await this.storage.bucket(this.bucketName).file(objectName).save(buffer, {
        contentType,
        ...(predefinedAcl ? { predefinedAcl } : {}),
      });
    } catch (err: unknown) {
      this.logger.error(`GCS upload failed [${objectName}]: ${JSON.stringify(err)}`);
      throw err;
    }
  }

  /** Streams a large object to a local file — avoids buffering videos in RAM. */
  async downloadToFile(objectName: string, destination: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(objectName).download({ destination });
  }

  /** Downloads a (small) object into memory — used for image processing. */
  async download(objectName: string): Promise<Buffer> {
    const [buffer] = await this.storage.bucket(this.bucketName).file(objectName).download();
    return buffer;
  }

  /** Streams a local file to GCS — used for transcode outputs (segments, renditions). */
  async uploadFromFile(
    localPath: string,
    objectName: string,
    contentType: string,
    predefinedAcl?: 'publicRead' | 'private',
  ): Promise<void> {
    await this.storage.bucket(this.bucketName).upload(localPath, {
      destination: objectName,
      contentType,
      ...(predefinedAcl ? { predefinedAcl } : {}),
    });
  }

  async delete(objectName: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(objectName).delete({ ignoreNotFound: true });
  }
}
