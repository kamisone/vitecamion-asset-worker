import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DLQ_QUEUE } from './dlq.constants';
import { DlqService } from './dlq.service';

@Module({
  imports: [BullModule.registerQueue({ name: DLQ_QUEUE })],
  providers: [DlqService],
  exports: [DlqService],
})
export class DlqModule {}
