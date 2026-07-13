import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { config } from 'dotenv';
import { MediaAsset } from './media/media-asset.entity';
import { ProcessingModule } from './media/processing.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthController } from './health/health.controller';

// Must run before the @Module decorator below is evaluated: TypeOrmModule.forRoot()
// reads process.env.* as soon as this file is imported (decorator arguments are
// evaluated at class-definition time), which happens before main.ts's own
// config() call. In Kubernetes this is a no-op (the container env is already
// populated by kubelet before Node starts); for local dev via .env it's required
// — matches the same fix already applied in back/src/app.module.ts.
config({ quiet: true });

@Module({
  imports: [
    // Same database as the API — asset-worker reads/writes MediaAsset rows
    // directly (no HTTP call back to the API in the processing path).
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.TYPEORM_HOST || 'localhost',
      port: parseInt(process.env.TYPEORM_PORT!, 10) || 5432,
      username: process.env.TYPEORM_USERNAME || 'postgres',
      password: process.env.TYPEORM_PASSWORD || '',
      database: process.env.TYPEORM_DATABASE || 'lghorba',
      entities: [MediaAsset],
      // Schema migrations are owned by the API (back/) — this process never runs them.
      migrationsRun: false,
      synchronize: false,
      extra: { options: '-c TimeZone=UTC' },
    }),
    // Must match back/src/app.module.ts's BullMQ connection EXACTLY — both
    // processes share one Redis instance with two logical DBs: REDIS_DB=0 is
    // the cache/auth Redis (never used for jobs), BULLMQ_REDIS_DB=1 is the
    // queue DB. Reading plain REDIS_DB here would silently connect this
    // consumer to the wrong database (0), since it IS set in both .env and
    // the K8s secret — jobs would enqueue on DB 1 and never be seen here,
    // sitting "Queued" forever with no error on either side.
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: {
          host:     process.env.BULLMQ_REDIS_HOST     ?? process.env.REDIS_HOST     ?? 'localhost',
          port:     Number(process.env.BULLMQ_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379),
          password: process.env.BULLMQ_REDIS_PASSWORD ?? process.env.REDIS_PASSWORD ?? undefined,
          db:       Number(process.env.BULLMQ_REDIS_DB  ?? 1),
        },
      }),
    }),
    MetricsModule,
    ProcessingModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
