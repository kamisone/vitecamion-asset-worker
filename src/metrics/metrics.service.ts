import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Single Prometheus registry for this pod, exposed on /metrics by
 * HealthController. No scraper is configured on this cluster yet — this is
 * cheap to expose now and makes "resource usage" (default process/CPU/memory
 * metrics) and job duration/failure data available the moment one is added,
 * without another code change.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly jobsTotal = new Counter({
    name: 'asset_worker_jobs_total',
    help: 'Jobs processed, by job name and outcome',
    labelNames: ['jobName', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly jobDurationSeconds = new Histogram({
    name: 'asset_worker_job_duration_seconds',
    help: 'End-to-end job duration in seconds, by job name',
    labelNames: ['jobName'] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200],
    registers: [this.registry],
  });

  readonly activeJobs = new Gauge({
    name: 'asset_worker_active_jobs',
    help: 'Jobs currently being processed by this pod',
    registers: [this.registry],
  });

  /** Set on-demand at scrape time (see HealthController) rather than via a background poller. */
  readonly queueDepth = new Gauge({
    name: 'asset_worker_queue_depth',
    help: 'Jobs waiting/delayed/active in the video-transcode queue',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });

  constructor() {
    // process_cpu_*, process_resident_memory_bytes, nodejs_eventloop_lag_seconds, etc.
    // — covers "resource usage" monitoring without any hand-rolled instrumentation.
    collectDefaultMetrics({ register: this.registry });
  }
}
