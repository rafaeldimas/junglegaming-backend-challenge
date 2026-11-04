import { Module } from '@nestjs/common';
import { APP_ENV } from '../config/tokens.js';
import { AppEnv } from '../config/env.js';
import { UNIT_OF_WORK, UnitOfWork } from '../platform/database/transaction-context.js';
import { Clock, CLOCK } from '../shared/domain/clock.js';
import { WageringModule } from '../wagering/wagering.module.js';
import { PROCESS_WAGER_TRANSACTION_USE_CASE, ProcessWagerTransactionUseCase } from '../wagering/application/process-wager-transaction.use-case.js';
import { WagerTransactionApplier } from '../wagering/application/wager-transaction-applier.js';
import { SqsClient } from './sqs/sqs.client.js';
import { SqsQueues } from './sqs/sqs-queues.js';
import { EVENT_PUBLISHER, EventPublisher, SqsEventPublisher } from './sqs/sqs-publisher.js';
import { OutboxPublisherWorker } from './outbox/outbox-publisher.worker.js';
import { PendingReferenceWorker } from './workers/pending-reference.worker.js';
import { SqsConsumer } from './sqs/sqs-consumer.worker.js';

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: SqsClient,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => new SqsClient(env),
    },
    {
      provide: SqsQueues,
      inject: [SqsClient, APP_ENV],
      useFactory: (client: SqsClient, env: AppEnv) => new SqsQueues(client, env),
    },
    {
      provide: EVENT_PUBLISHER,
      inject: [SqsClient, SqsQueues],
      useFactory: (client: SqsClient, queues: SqsQueues) => new SqsEventPublisher(client, queues),
    },
    {
      provide: OutboxPublisherWorker,
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_ENV],
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, env: AppEnv) =>
        new OutboxPublisherWorker(uow, publisher, clock, env),
    },
    {
      provide: PendingReferenceWorker,
      inject: [UNIT_OF_WORK, WagerTransactionApplier, CLOCK, APP_ENV],
      useFactory: (uow: UnitOfWork, applier: WagerTransactionApplier, clock: Clock, env: AppEnv) =>
        new PendingReferenceWorker(uow, applier, clock, env),
    },
    {
      provide: SqsConsumer,
      inject: [SqsClient, SqsQueues, PROCESS_WAGER_TRANSACTION_USE_CASE, CLOCK, APP_ENV],
      useFactory: (
        client: SqsClient,
        queues: SqsQueues,
        useCase: ProcessWagerTransactionUseCase,
        clock: Clock,
        env: AppEnv,
      ) => new SqsConsumer(client, queues, useCase, clock, env),
    },
  ],
  exports: [SqsClient, SqsQueues],
})
export class MessagingModule {}
