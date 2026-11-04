import { Module } from '@nestjs/common';
import { APP_ENV } from '../config/tokens.js';
import { AppEnv } from '../config/env.js';
import { Clock, CLOCK } from '../shared/domain/clock.js';
import { IdGenerator, ID_GENERATOR } from '../shared/domain/id-generator.js';
import { UnitOfWork, UNIT_OF_WORK } from '../platform/database/transaction-context.js';
import { WagerTransactionApplier } from './application/wager-transaction-applier.js';
import {
  PROCESS_WAGER_TRANSACTION_USE_CASE,
  ProcessWagerTransactionUseCase,
} from './application/process-wager-transaction.use-case.js';
import { GetWagerTransactionUseCase } from './application/wager-queries.use-case.js';
import { WageringController } from './http/wagering.controller.js';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: WagerTransactionApplier,
      inject: [CLOCK, ID_GENERATOR, APP_ENV],
      useFactory: (clock: Clock, ids: IdGenerator, env: AppEnv) =>
        new WagerTransactionApplier(clock, ids, {
          maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
          ttlMs: env.PENDING_REFERENCE_TTL_MINUTES * 60_000,
        }),
    },
    {
      provide: PROCESS_WAGER_TRANSACTION_USE_CASE,
      inject: [UNIT_OF_WORK, WagerTransactionApplier, CLOCK, ID_GENERATOR],
      useFactory: (
        uow: UnitOfWork,
        applier: WagerTransactionApplier,
        clock: Clock,
        ids: IdGenerator,
      ) => new ProcessWagerTransactionUseCase(uow, applier, clock, ids),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWagerTransactionUseCase(uow),
    },
  ],
  exports: [WagerTransactionApplier, PROCESS_WAGER_TRANSACTION_USE_CASE],
})
export class WageringModule {}
