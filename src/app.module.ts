import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { HealthModule } from './health/health.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { DatabaseModule } from './platform/database/database.module.js';
import { AllExceptionsFilter } from './platform/http/exception.filter.js';
import { RequestContextMiddleware } from './platform/http/request-context.middleware.js';
import { KernelModule } from './platform/kernel.module.js';
import { WageringModule } from './wagering/wagering.module.js';
import { WalletsModule } from './wallets/wallets.module.js';

@Module({
  imports: [
    DatabaseModule.forRoot(),
    KernelModule,
    AuthModule,
    WalletsModule,
    WageringModule,
    MessagingModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
