import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/** @Global so both ProcessingModule (the processor) and AppModule (HealthController's
 * /metrics endpoint) share the exact same registry/counters without re-registering them. */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
