import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VIDEO_TRANSCODE_QUEUE } from '../media/video-transcode.constants';

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
}
