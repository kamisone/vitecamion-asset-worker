/**
 * Job contract shared with the API (back/src/media/video-transcode.constants.ts).
 * Queue name and job names MUST stay byte-for-byte identical on both sides —
 * back only enqueues onto this queue; asset-worker is the sole consumer.
 * No shared package exists between the two services yet, so this file is a
 * deliberate mirror: if you change one side, change the other.
 */
export const VIDEO_TRANSCODE_QUEUE = 'video-transcode';
export const TRANSCODE_JOB = 'transcode-asset';
export const CONVERT_VIDEO_JOB = 'convert-video';
export const CONVERT_IMAGE_JOB = 'convert-image';

export interface TranscodeJobData {
  assetId: string;
}

export type VideoConvertFormat = 'mp4' | 'webm' | 'original';
export type ImageConvertFormat = 'webp' | 'avif' | 'jpeg' | 'png' | 'original';

export interface ConvertVideoJobData {
  assetId: string;
  format: VideoConvertFormat;
  quality: number;
}

export interface ConvertImageJobData {
  assetId: string;
  format: ImageConvertFormat;
  quality: number;
}
