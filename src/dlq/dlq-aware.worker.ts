import { Logger } from '@nestjs/common';
import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DlqService } from './dlq.service';

/**
 * Mirrors back/src/dlq/dlq-aware.worker.ts. The @OnWorkerEvent('error')
 * handler is critical: without it, a BullMQ Worker's 'error' emit (Redis
 * hiccups, lock-renewal timeouts under load) is an uncaught exception that
 * kills the process — exactly the failure mode this dedicated pod exists to
 * be isolated from, so it must never propagate up and crash asset-worker.
 */
export abstract class DlqAwareWorker extends WorkerHost {
  protected abstract readonly queueName: string;
  private readonly workerLogger = new Logger('BullWorker');

  constructor(protected readonly dlqService: DlqService) {
    super();
  }

  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.workerLogger.error(`[${this.queueName}] worker error: ${error.message}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job) return;
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await this.dlqService.route(this.queueName, job, error);
    }
  }
}
