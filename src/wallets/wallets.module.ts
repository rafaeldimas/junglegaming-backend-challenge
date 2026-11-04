import { Module } from '@nestjs/common';
import { Clock, CLOCK } from '../shared/domain/clock.js';
import { IdGenerator, ID_GENERATOR } from '../shared/domain/id-generator.js';
import { UnitOfWork, UNIT_OF_WORK } from '../platform/database/transaction-context.js';
import { CreateWalletUseCase } from './application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case.js';
import { GetWalletLedgerUseCase, GetWalletUseCase } from './application/wallet-queries.use-case.js';
import { WalletController } from './http/wallet.controller.js';

@Module({
  controllers: [WalletController],
  providers: [
    {
      provide: CreateWalletUseCase,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new CreateWalletUseCase(uow, clock, ids),
    },
    {
      provide: GetWalletUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWalletUseCase(uow),
    },
    {
      provide: GetWalletLedgerUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new GetWalletLedgerUseCase(uow),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new ReconcileWalletUseCase(uow),
    },
  ],
})
export class WalletsModule {}
