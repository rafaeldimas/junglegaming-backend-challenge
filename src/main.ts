import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { PinoLoggerService } from './platform/logging/logger.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = new PinoLoggerService();

  const app = await NestFactory.create(AppModule, { logger });
  app.useLogger(logger);
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  await app.listen(env.PORT, '0.0.0.0');
}

await bootstrap();
