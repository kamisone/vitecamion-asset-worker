import {
  Column, CreateDateColumn, Entity, Index,
  PrimaryGeneratedColumn, UpdateDateColumn,
} from 'typeorm';

/**
 * Mirrors back/src/media/media-asset.entity.ts — same table, same columns.
 * The `usages` relation (media_usages) is intentionally omitted: asset-worker
 * never needs to know where an asset is referenced, only how to process it.
 */
@Entity('media_assets')
@Index(['mimeType'])
@Index(['createdAt'])
export class MediaAsset {
  @PrimaryGeneratedColumn('uuid') id: string;

  /** GCS object path, e.g. "media/2024/01/abc123.jpg" */
  @Column({ type: 'varchar', length: 1000, unique: true }) storageKey: string;

  @Column({ type: 'varchar', length: 500 })             originalFilename: string;
  @Column({ type: 'varchar', length: 100 })             mimeType: string;
  @Column({ type: 'int' })                              sizeBytes: number;

  @Column({ type: 'int', nullable: true })              width:  number | null;
  @Column({ type: 'int', nullable: true })              height: number | null;

  /** Video duration in seconds — extracted on upload for video/* assets */
  @Column({ type: 'int', nullable: true })              durationSeconds: number | null;

  // ── Video transcode outputs (video/* assets only; null = not transcoded) ──

  /** GCS key of the HLS master playlist (.m3u8) */
  @Column({ type: 'varchar', length: 1000, nullable: true }) hlsKey: string | null;

  /** GCS key of the optimized MP4 fallback rendition */
  @Column({ type: 'varchar', length: 1000, nullable: true }) mp4Key: string | null;

  /** GCS key of the auto-extracted poster frame (JPEG) */
  @Column({ type: 'varchar', length: 1000, nullable: true }) autoPosterKey: string | null;

  /** null = legacy asset / not a video — never enqueued for transcoding */
  @Column({ type: 'varchar', length: 20, nullable: true })
  transcodeStatus: 'pending' | 'processing' | 'ready' | 'failed' | null;

  @Column({ type: 'varchar', length: 500, nullable: true }) altText: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) title: string | null;

  /** Free-form tags for organization */
  @Column({ type: 'text', array: true, default: '{}' }) tags: string[];

  /** SHA-256 hex of the file — enables dedup detection */
  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index()
  checksum: string | null;

  /** Admin user ID who uploaded (loose reference, no FK — admin may be deleted) */
  @Column({ type: 'varchar', length: 200, nullable: true }) uploadedBy: string | null;

  @Column({ name: 'folder_id', type: 'uuid', nullable: true })
  @Index()
  folderId: string | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
