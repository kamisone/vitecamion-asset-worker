import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { DLQ_QUEUE } from './dlq.constants';

/** Mirrors back/src/dlq/dlq.service.ts — same dead-letter queue, same shape. */
@Injectable()
export class DlqService {
  private readonly logger = new Logger('DeadLetterQueue');

  constructor(
    @InjectQueue(DLQ_QUEUE) private readonly dlqQueue: Queue,
  ) {}

  async route(queueName: string, job: Job, error: Error): Promise<void> {
    this.logger.error(
      `[DLQ] Job permanently failed — queue=${queueName} name=${job.name} ` +
      `id=${job.id} attempts=${job.attemptsMade} error="${error.message}"`,
      { queueName, jobName: job.name, jobId: job.id, jobData: job.data, attemptsMade: job.attemptsMade, errorMessage: error.message },
    );

    try {
      await this.dlqQueue.add(
        job.name,
        {
          originalQueue:   queueName,
          originalJobId:   job.id,
          originalJobName: job.name,
          originalJobData: job.data,
          attemptsMade:    job.attemptsMade,
          failedAt:        new Date().toISOString(),
          errorMessage:    error.message,
          errorStack:      error.stack,
        },
        // Keep DLQ entries forever — they must not be silently evicted.
        { removeOnComplete: false, removeOnFail: false },
      );
    } catch (enqueueError) {
      this.logger.error(`[DLQ] Failed to enqueue to dead-letter queue: ${(enqueueError as Error).message}`);
    }
  }
}
