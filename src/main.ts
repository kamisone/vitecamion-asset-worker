import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

import { config } from 'dotenv';

config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // On SIGTERM (pod termination/redeploy), let BullMQ release its in-flight
  // job lock and close the Postgres/Redis connections cleanly instead of
  // hard-killing them — an interrupted job simply gets picked up by another
  // pod (or this one, on restart) via BullMQ's stalled-job recovery.
  app.enableShutdownHooks();
  await app.listen(process.env.BACK_PORT || 4000);
}
bootstrap();
