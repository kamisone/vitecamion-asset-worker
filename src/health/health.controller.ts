import { Controller, Get, HttpCode, HttpStatus, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VIDEO_TRANSCODE_QUEUE } from '../media/video-transcode.constants';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Internal-only endpoints (no public Service/Ingress — enforced at the
 * NetworkPolicy level, not here) so Kubernetes can supervise this pod
 * independently of whether it's mid-job.
 */
@Controller()
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(VIDEO_TRANSCODE_QUEUE) private readonly queue: Queue,
    private readonly metrics: MetricsService,
  ) {}

  /** Liveness: the process is alive. Deliberately checks nothing external — a
   * Redis/DB blip must never cause Kubernetes to restart an otherwise-healthy pod. */
  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  healthz(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness: only claim ready once actually able to pick up jobs. */
  @Get('readyz')
  async readyz(): Promise<{ status: string }> {
    if (!this.dataSource.isInitialized) {
      throw new ServiceUnavailableException({ status: 'not-ready', reason: 'database not connected' });
    }
    try {
      await this.queue.client; // resolves once the underlying ioredis connection is usable
    } catch {
      throw new ServiceUnavailableException({ status: 'not-ready', reason: 'redis not connected' });
    }
    return { status: 'ready' };
  }

  /** Prometheus exposition format — queue depth, job duration/outcome, active jobs, resource usage. */
  @Get('metrics')
  async metricsHandler(@Res() res: Response): Promise<void> {
    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      for (const [state, count] of Object.entries(counts)) {
        this.metrics.queueDepth.set({ state }, count);
      }
    } catch {
      // Redis unreachable — /readyz already reflects this; /metrics just omits queue depth this scrape.
    }
    res.set('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
