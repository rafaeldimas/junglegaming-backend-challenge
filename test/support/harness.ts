import { MikroORM } from '@mikro-orm/postgresql';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { AppEnv, loadEnv } from '../../src/config/env.js';
import { createOrmConfig } from '../../src/platform/database/mikro-orm.config.js';
import { MikroOrmUnitOfWork } from '../../src/platform/database/unit-of-work.js';
import { Clock } from '../../src/shared/domain/clock.js';
import { UuidV7Generator } from '../../src/shared/domain/id-generator.js';
import { Money } from '../../src/shared/domain/money.js';
import { CreateWalletUseCase } from '../../src/wallets/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../../src/wallets/application/reconcile-wallet.use-case.js';
import { Wallet } from '../../src/wallets/domain/wallet.js';
import { WagerTransactionApplier } from '../../src/wagering/application/wager-transaction-applier.js';
import {
  ProcessWagerTransactionUseCase,
  ProcessWagerTransactionOptions,
  ProcessWagerTransactionResult,
} from '../../src/wagering/application/process-wager-transaction.use-case.js';
import { WagerTransactionCommand } from '../../src/wagering/application/wager-command.js';
import { TransactionOrigin, WagerTransactionKind } from '../../src/wagering/domain/wager-transaction.js';
import { SqsClient } from '../../src/messaging/sqs/sqs.client.js';
import { SqsQueues } from '../../src/messaging/sqs/sqs-queues.js';
import { SqsEventPublisher } from '../../src/messaging/sqs/sqs-publisher.js';
import { OutboxPublisherWorker } from '../../src/messaging/outbox/outbox-publisher.worker.js';
import { PendingReferenceWorker } from '../../src/messaging/workers/pending-reference.worker.js';
import { WagerTransactionRow } from '../../src/wagering/persistence/wager-transaction.row.js';
import { WalletRow } from '../../src/wallets/persistence/wallet.row.js';

/** Clock controlled by the tests, so retry/backoff logic is deterministic. */
export class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Harness {
  postgres: StartedPostgreSqlContainer;
  localstack: StartedTestContainer;
  orm: MikroORM;
  env: AppEnv;
  clock: MutableClock;
  ids: UuidV7Generator;
  uow: MikroOrmUnitOfWork;
  applier: WagerTransactionApplier;
  processTransaction: ProcessWagerTransactionUseCase;
  createWallet: CreateWalletUseCase;
  reconcile: ReconcileWalletUseCase;
  sqs: SqsClient;
  queues: SqsQueues;
  publisher: SqsEventPublisher;
  /** Simulates another application instance sharing the same database. */
  newInstance(): {
    uow: MikroOrmUnitOfWork;
    applier: WagerTransactionApplier;
    processTransaction: ProcessWagerTransactionUseCase;
    createWallet: CreateWalletUseCase;
    reconcile: ReconcileWalletUseCase;
    outboxPublisher(): OutboxPublisherWorker;
    pendingReferenceWorker(): PendingReferenceWorker;
  };
  outboxPublisher(): OutboxPublisherWorker;
  pendingReferenceWorker(): PendingReferenceWorker;
  /** New ORM instance, like a process starting after a crash. */
  newOrm(): Promise<MikroORM>;
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

const POLICY = { maxAttempts: 2, ttlMs: 120_000 };

export async function startHarness(): Promise<Harness> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('jungle')
    .withUsername('jungle')
    .withPassword('jungle')
    .start();

  const localstack = await new GenericContainer('localstack/localstack:3.8')
    .withEnvironment({ SERVICES: 'sqs' })
    .withExposedPorts(4566)
    .withWaitStrategy(Wait.forHttp('/_localstack/health', 4566))
    .start();

  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: postgres.getConnectionUri(),
    SQS_ENDPOINT: `http://${localstack.getHost()}:${localstack.getMappedPort(4566)}`,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
    SQS_MAX_ATTEMPTS: '2',
    // Workers are constructed manually in the tests; the feature flags only
    // gate the Nest bootstrap hooks, which these tests do not use.
    SHUTDOWN_GRACE_MS: '1000',
    QUEUE_AUTO_CREATE: 'true',
    LOG_LEVEL: 'silent',
  });

  const orm = await MikroORM.init(createOrmConfig(env));
  await orm.migrator.up();

  const clock = new MutableClock(new Date('2026-01-01T12:00:00.000Z'));
  const ids = new UuidV7Generator();
  const sqs = new SqsClient(env);
  const queues = new SqsQueues(sqs, env);
  await queues.ensureReady();

  const sql = async <T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> =>
    orm.em.fork().getConnection().execute<T[]>(query, params);

  const buildInstance = (instanceOrm: MikroORM = orm) => {
    const uow = new MikroOrmUnitOfWork(instanceOrm);
    const applier = new WagerTransactionApplier(clock, ids, POLICY);
    return {
      uow,
      applier,
      processTransaction: new ProcessWagerTransactionUseCase(uow, applier, clock, ids),
      createWallet: new CreateWalletUseCase(uow, clock, ids),
      reconcile: new ReconcileWalletUseCase(uow),
      outboxPublisher: () => new OutboxPublisherWorker(uow, new SqsEventPublisher(sqs, queues), clock, env),
      pendingReferenceWorker: () => new PendingReferenceWorker(uow, applier, clock, env),
    };
  };

  const current = buildInstance();

  const harness: Harness = {
    postgres,
    localstack,
    orm,
    env,
    clock,
    ids,
    sqs,
    queues,
    publisher: new SqsEventPublisher(sqs, queues),
    ...current,
    newInstance: () => buildInstance(),
    outboxPublisher: current.outboxPublisher,
    pendingReferenceWorker: current.pendingReferenceWorker,
    newOrm: async () => {
      const other = await MikroORM.init(createOrmConfig(env));
      return other;
    },
    sql,
    reset: async () => {
      await sql(
        'truncate table inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets cascade',
      );
    },
    stop: async () => {
      await orm.close(true);
      await localstack.stop();
      await postgres.stop();
    },
  };

  return harness;
}

export function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

export interface SubmitOverrides {
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  gameId?: string;
  kind?: WagerTransactionKind;
  money?: Money;
  referenceExternalTransactionId?: string;
  inbox?: ProcessWagerTransactionOptions['inbox'];
  origin?: TransactionOrigin.Api | TransactionOrigin.Sqs;
}

export function commandFor(wallet: Wallet, overrides: SubmitOverrides = {}): WagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${crypto.randomUUID()}`;
  return {
    providerId: overrides.providerId ?? 'provider-a',
    externalTransactionId,
    idempotencyKey: overrides.idempotencyKey ?? `provider-a:${externalTransactionId}`,
    playerId: overrides.playerId ?? wallet.playerId,
    walletId: overrides.walletId ?? wallet.id,
    roundId: overrides.roundId ?? 'round-1',
    gameId: overrides.gameId ?? 'fortune-chimp',
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    money: overrides.money ?? brl('10.00'),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  };
}

export function submit(
  harness: Harness,
  command: WagerTransactionCommand,
  overrides: { inbox?: ProcessWagerTransactionOptions['inbox']; origin?: TransactionOrigin.Api | TransactionOrigin.Sqs } = {},
): Promise<ProcessWagerTransactionResult> {
  return harness.processTransaction.execute(command, {
    origin: overrides.origin ?? TransactionOrigin.Api,
    correlationId: 'test-correlation',
    inbox: overrides.inbox,
  });
}

export async function walletRow(harness: Harness, walletId: string): Promise<WalletRow | null> {
  return harness.orm.em.fork().findOne(WalletRow, { id: walletId });
}

export async function transactionRow(
  harness: Harness,
  transactionId: string,
): Promise<WagerTransactionRow | null> {
  return harness.orm.em.fork().findOne(WagerTransactionRow, { id: transactionId });
}

export async function createWallet(
  harness: Harness,
  initialBalance = '100.00',
): Promise<Wallet> {
  return harness.createWallet.execute(
    { playerId: crypto.randomUUID(), initialBalance: brl(initialBalance) },
    'test-correlation',
  );
}
