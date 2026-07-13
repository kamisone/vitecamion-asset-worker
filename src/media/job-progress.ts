import { Job } from 'bullmq';

const MIN_REPORT_INTERVAL_MS = 2000;
const MIN_PERCENT_DELTA = 2;

/**
 * Throttled wrapper around BullMQ's native job.updateProgress() (a plain
 * Redis field on the job hash — readable from the API side via the same
 * Queue.getJobs() call it already uses for the "Processing" panel, no new
 * transport needed). ffmpeg's own 'progress' event can fire many times a
 * second; writing every tick to Redis would be wasteful for a value that's
 * only ever read on a ~6s admin poll, so this only writes when enough time
 * AND enough percent change has passed since the last write.
 */
export class JobProgressReporter {
  private lastReportedAt = 0;
  private lastPercent = -1;

  constructor(private readonly job: Job) {}

  /** Report overall job progress (0-100). Throttled; safe to call as often as ffmpeg emits. */
  report(percent: number): void {
    const clamped = Math.min(100, Math.max(0, Math.round(percent) || 0));
    const now = Date.now();
    const isFinal = clamped >= 100;
    if (!isFinal
      && clamped - this.lastPercent < MIN_PERCENT_DELTA
      && now - this.lastReportedAt < MIN_REPORT_INTERVAL_MS) {
      return;
    }
    this.lastPercent = clamped;
    this.lastReportedAt = now;
    // A lost lock (e.g. under CPU pressure) could make this reject — a
    // progress-reporting hiccup must never fail the actual encode.
    void this.job.updateProgress(clamped).catch(() => {});
  }

  /**
   * For a multi-stage pipeline (HLS ladder + MP4 fallback): maps this one
   * stage's own 0-100 ffmpeg percent into the job's overall 0-100 range.
   * Stages are weighted equally — a deliberate simplification (a 1080p pass
   * genuinely costs more than a 480p pass, but exact cost estimation isn't
   * worth the complexity for a progress indicator, not a scheduler).
   */
  reportStage(stageIndex: number, totalStages: number, stageLocalPercent: number): void {
    const local = Math.min(100, Math.max(0, stageLocalPercent || 0));
    this.report(((stageIndex + local / 100) / totalStages) * 100);
  }
}
