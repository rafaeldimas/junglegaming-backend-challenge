import {
  SQSClient,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import {
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../src/platform/errors/application-error.js';
import type { ProcessWagerTransactionUseCase } from '../src/wagering/application/process-wager-transaction.use-case.js';
import { InvalidTransactionStateError } from '../src/shared/domain/errors.js';
import { FailureCode } from '../src/wagering/domain/failure-code.js';
import {
  TransactionOrigin,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/wagering/domain/wager-transaction.js';
import { SqsConsumer } from '../src/messaging/sqs/sqs-consumer.worker.js';
import { GetWalletLedgerUseCase } from '../src/wallets/application/wallet-queries.use-case.js';
import { decodeLedgerCursor } from '../src/wallets/application/cursor.js';
import type { LedgerCursor } from '../src/wallets/application/ports.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { MikroOrmUnitOfWork } from '../src/platform/database/unit-of-work.js';
import { OutboxPublisherWorker } from '../src/messaging/outbox/outbox-publisher.worker.js';
import { SqsEventPublisher } from '../src/messaging/sqs/sqs-publisher.js';
import {
  createWallet,
  brl,
  commandFor,
  Harness,
  startHarness,
  submit,
  transactionRow,
  walletRow,
} from './support/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
}, 300_000);

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  h.clock.reset();
  await h.reset();
});

/** Drains a FIFO queue and returns the message bodies seen. */
async function drainQueue(queueName: string): Promise<string[]> {
  const client = new SQSClient({
    endpoint: h.env.SQS_ENDPOINT,
    region: h.env.AWS_REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({ QueueName: queueName }),
  );
  const bodies: string[] = [];
  for (;;) {
    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 1,
      }),
    );
    const messages = received.Messages ?? [];
    if (messages.length === 0) {
      break;
    }
    for (const message of messages) {
      bodies.push(message.Body ?? '');
      await client.send(
        new DeleteMessageCommand({
          QueueUrl,
          ReceiptHandle: message.ReceiptHandle!,
        }),
      );
    }
  }
  client.destroy();
  return bodies;
}

async function queueDepth(queueName: string): Promise<number> {
  const client = new SQSClient({
    endpoint: h.env.SQS_ENDPOINT,
    region: h.env.AWS_REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({ QueueName: queueName }),
  );
  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  client.destroy();
  return Number(attributes.Attributes?.ApproximateNumberOfMessages ?? '0');
}

async function sendRaw(
  queueName: string,
  body: string,
  groupId = 'raw',
): Promise<void> {
  const client = new SQSClient({
    endpoint: h.env.SQS_ENDPOINT,
    region: h.env.AWS_REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const { QueueUrl } = await client.send(
    new GetQueueUrlCommand({ QueueName: queueName }),
  );
  await client.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
  client.destroy();
}

async function expectReconciled(walletId: string): Promise<void> {
  const result = await h.reconcile.execute(walletId);
  expect(result.consistent).toBe(true);
  expect(result.difference.isZero()).toBe(true);
}

describe('schema guarantees', () => {
  it('enforces non-negative balances, ledger immutability and uniqueness in the database', async () => {
    const wallet = await createWallet(h, '10.00');

    await expect(
      h.sql('update wallets set balance = -1 where id = ?', [wallet.id]),
    ).rejects.toThrow();
    await expect(
      h.sql('update wallet_ledger_entries set amount = 1 where wallet_id = ?', [
        wallet.id,
      ]),
    ).rejects.toThrow();
    await expect(
      h.sql('delete from wallet_ledger_entries where wallet_id = ?', [
        wallet.id,
      ]),
    ).rejects.toThrow();

    // One wallet per player + currency.
    await expect(
      h.createWallet.execute(
        { playerId: wallet.playerId, initialBalance: brl('1.00') },
        'test',
      ),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);

    // Ledger: at most one entry per transaction.
    const [entry] = await h.sql<{
      transaction_id: string;
      wallet_id: string;
      direction: string;
      amount: string;
      currency: string;
      balance_before: string;
      balance_after: string;
    }>(
      'select transaction_id, wallet_id, direction, amount, currency, balance_before, balance_after from wallet_ledger_entries where wallet_id = ?',
      [wallet.id],
    );
    await expect(
      h.sql(
        `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, ?, ?, 'CREDIT', '1.00', 'BRL', '10.00', '11.00', now())`,
        [crypto.randomUUID(), wallet.id, entry!.transaction_id],
      ),
    ).rejects.toThrow();
  });

  it('rejects external OPENING transactions at the database level', async () => {
    const wallet = await createWallet(h, '10.00');

    await expect(
      h.sql(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, origin, correlation_id,
            wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
            pending_reference_attempts, created_at, updated_at)
         values (?, 'p', 'ext', 'idem', repeat('a', 64), 'API', 'corr', ?, ?, 'r', 'g', 'OPENING', 'PROCESSED',
                 '1.00', 'BRL', 0, now(), now())`,
        [crypto.randomUUID(), wallet.id, wallet.playerId],
      ),
    ).rejects.toThrow();
  });

  it('rejects a second processed reversal of the same reference and kind', async () => {
    const wallet = await createWallet(h, '100.00');
    const bet = commandFor(wallet, { money: brl('10.00') });
    await submit(h, bet);

    await submit(
      h,
      commandFor(wallet, {
        kind: WagerTransactionKind.Rollback,
        money: brl('10.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    const [first] = await h.sql<{
      id: string;
      reference_transaction_id: string;
    }>(
      `select id, reference_transaction_id from wager_transactions
        where kind = 'ROLLBACK' and status = 'PROCESSED'`,
    );

    await expect(
      h.sql(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, origin, correlation_id,
            wallet_id, player_id, round_id, game_id, kind, status, amount, currency, reference_transaction_id,
            pending_reference_attempts, created_at, updated_at)
         values (?, 'provider-a', 'dup', 'dup', repeat('b', 64), 'API', 'c', ?, ?, 'r', 'g', 'ROLLBACK',
                 'PROCESSED', '10.00', 'BRL', ?, 0, now(), now())`,
        [
          crypto.randomUUID(),
          wallet.id,
          wallet.playerId,
          first!.reference_transaction_id,
        ],
      ),
    ).rejects.toThrow();
  });
});

describe('wallet creation atomicity', () => {
  it('commits wallet + OPENING + ledger + outbox together or not at all', async () => {
    const playerId = crypto.randomUUID();
    const [a, b] = await Promise.allSettled([
      h.createWallet.execute(
        { playerId, initialBalance: brl('100.00') },
        'test',
      ),
      h
        .newInstance()
        .createWallet.execute(
          { playerId, initialBalance: brl('100.00') },
          'test',
        ),
    ]);

    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);

    const [counts] = await h.sql<{
      wallets: number;
      openings: number;
      entries: number;
      outbox: number;
    }>(
      `select (select count(*)::int from wallets) as wallets,
              (select count(*)::int from wager_transactions where kind = 'OPENING') as openings,
              (select count(*)::int from wallet_ledger_entries) as entries,
              (select count(*)::int from outbox_messages) as outbox`,
    );

    expect(counts).toEqual({ wallets: 1, openings: 1, entries: 1, outbox: 2 });
  });

  it('opens a zero-balance wallet without an OPENING transaction', async () => {
    const wallet = await createWallet(h, '0.00');

    const [counts] = await h.sql<{
      openings: number;
      entries: number;
      outbox: number;
    }>(
      `select (select count(*)::int from wager_transactions) as openings,
              (select count(*)::int from wallet_ledger_entries) as entries,
              (select count(*)::int from outbox_messages) as outbox`,
    );
    expect(counts).toEqual({ openings: 0, entries: 0, outbox: 0 });
    expect(wallet.version).toBe(1);
  });
});

describe('idempotency', () => {
  it('replays the original result for a byte-identical request', async () => {
    const wallet = await createWallet(h, '100.00');
    const command = commandFor(wallet, { money: brl('25.00') });

    const first = await submit(h, command);
    const second = await submit(h, command);

    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.idempotentReplay).toBe(true);
    expect(second.balance?.toJSON().amount).toBe('75.00');

    const [counts] = await h.sql<{ debits: number }>(
      `select count(*)::int as debits from wallet_ledger_entries where direction = 'DEBIT'`,
    );
    expect(counts!.debits).toBe(1);
    await expectReconciled(wallet.id);
  });

  it('returns the result of a rejected transaction on replay', async () => {
    const wallet = await createWallet(h, '5.00');
    const command = commandFor(wallet, { money: brl('10.00') });

    const first = await submit(h, command);
    const second = await submit(h, command);

    expect(first.status).toBe(WagerTransactionStatus.Rejected);
    expect(first.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.idempotentReplay).toBe(true);
  });

  it('treats the same key with a different payload as a conflict', async () => {
    const wallet = await createWallet(h, '100.00');
    const command = commandFor(wallet, { money: brl('25.00') });
    await submit(h, command);

    await expect(
      submit(h, { ...command, money: brl('30.00') }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect((await walletRow(h, wallet.id))!.balance).toBe('75.00');
  });

  it('rejects the same external transaction id under another idempotency key', async () => {
    const wallet = await createWallet(h, '100.00');
    const command = commandFor(wallet);
    await submit(h, command);

    await expect(
      submit(h, { ...command, idempotencyKey: 'provider-a:another-key' }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_TRANSACTION_CONFLICT' });
  });
});

describe('inbox deduplication', () => {
  it('does not duplicate effects when the same message is redelivered', async () => {
    const wallet = await createWallet(h, '100.00');
    const command = commandFor(wallet, { money: brl('25.00') });
    const inbox = {
      consumerName: 'sqs:wager-transactions',
      messageId: 'msg-redelivered',
      receivedAt: h.clock.now(),
    };

    const first = await submit(h, command, {
      origin: TransactionOrigin.Sqs,
      inbox,
    });
    const second = await submit(h, command, {
      origin: TransactionOrigin.Sqs,
      inbox,
    });

    expect(first.duplicateMessage).toBeUndefined();
    expect(second.duplicateMessage).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect((await walletRow(h, wallet.id))!.balance).toBe('75.00');

    const [counts] = await h.sql<{
      inbox: number;
      debits: number;
      outbox: number;
    }>(
      `select (select count(*)::int from inbox_messages) as inbox,
              (select count(*)::int from wallet_ledger_entries where direction = 'DEBIT') as debits,
              (select count(*)::int from outbox_messages) as outbox`,
    );
    // Inbox, ledger and outbox commit in the same transaction: OPENING (2
    // events) + BET (processed + balance changed).
    expect(counts).toEqual({ inbox: 1, debits: 1, outbox: 4 });
  });

  it('rolls back the inbox row when the financial transaction fails', async () => {
    const wallet = await createWallet(h, '100.00');
    const command = {
      ...commandFor(wallet),
      walletId: crypto.randomUUID(),
    };

    await expect(
      submit(h, command, {
        origin: TransactionOrigin.Sqs,
        inbox: {
          consumerName: 'sqs:wager-transactions',
          messageId: 'msg-rollback',
          receivedAt: h.clock.now(),
        },
      }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);

    const [counts] = await h.sql<{ inbox: number }>(
      'select count(*)::int as inbox from inbox_messages',
    );
    expect(counts!.inbox).toBe(0);
    expect((await walletRow(h, wallet.id))!.balance).toBe('100.00');
  });

  it('deduplicates a different message id carrying the same business payload', async () => {
    const wallet = await createWallet(h, '100.00');
    const command = commandFor(wallet, { money: brl('25.00') });

    const first = await submit(h, command, {
      origin: TransactionOrigin.Sqs,
      inbox: {
        consumerName: 'sqs:wager-transactions',
        messageId: 'msg-1',
        receivedAt: h.clock.now(),
      },
    });
    const second = await submit(h, command, {
      origin: TransactionOrigin.Sqs,
      inbox: {
        consumerName: 'sqs:wager-transactions',
        messageId: 'msg-2',
        receivedAt: h.clock.now(),
      },
    });

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect((await walletRow(h, wallet.id))!.balance).toBe('75.00');
  });
});

describe('concurrency', () => {
  it('records LOSS without moving the balance, the ledger or the version', async () => {
    const wallet = await createWallet(h, '100.00');
    const loss = commandFor(wallet, {
      kind: WagerTransactionKind.Loss,
      money: brl('10.00'),
    });

    const result = await submit(h, loss);
    expect(result.status).toBe(WagerTransactionStatus.Processed);

    const stored = await walletRow(h, wallet.id);
    expect(stored!.balance).toBe('100.00');
    expect(stored!.version).toBe(1);

    const [counts] = await h.sql<{
      entries: number;
      processed_events: number;
      balance_events: number;
    }>(
      `select
         (select count(*)::int from wallet_ledger_entries where transaction_id = ?) as entries,
         (select count(*)::int from outbox_messages where event_type = 'WagerTransactionProcessed') as processed_events,
         (select count(*)::int from outbox_messages where event_type = 'WalletBalanceChanged') as balance_events`,
      [result.transactionId],
    );
    expect(counts).toEqual({
      entries: 0,
      processed_events: 2, // OPENING + LOSS
      balance_events: 1, // OPENING only
    });
    await expectReconciled(wallet.id);
  });

  it('processes the same bet 50 times in parallel as a single debit', async () => {
    const wallet = await createWallet(h, '100.00');
    const command = commandFor(wallet, { money: brl('25.00') });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit(h, command)),
    );

    const processed = results.filter(
      (result) => result.status === WagerTransactionStatus.Processed,
    );
    expect(processed).toHaveLength(50);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(
      results.filter((result) => result.idempotentReplay === true).length,
    ).toBeGreaterThan(0);

    expect((await walletRow(h, wallet.id))!.balance).toBe('75.00');
    const [counts] = await h.sql<{ debits: number; processed: number }>(
      `select (select count(*)::int from wallet_ledger_entries where direction = 'DEBIT') as debits,
              (select count(*)::int from wager_transactions where status = 'PROCESSED' and kind = 'BET') as processed`,
    );
    expect(counts).toEqual({ debits: 1, processed: 1 });
    await expectReconciled(wallet.id);
  });

  it('resolves the 80/80 race with one processed bet and one rejection', async () => {
    const wallet = await createWallet(h, '100.00');
    const results = await Promise.all([
      submit(h, commandFor(wallet, { money: brl('80.00') })),
      submit(h, commandFor(wallet, { money: brl('80.00') })),
    ]);

    expect(
      results.map((result) => result.status).sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    expect(
      results.find(
        (result) => result.status === WagerTransactionStatus.Rejected,
      )?.failureCode,
    ).toBe(FailureCode.InsufficientFunds);
    expect((await walletRow(h, wallet.id))!.balance).toBe('20.00');

    const [counts] = await h.sql<{ debits: number }>(
      `select count(*)::int as debits from wallet_ledger_entries where direction = 'DEBIT'`,
    );
    expect(counts!.debits).toBe(1);
    await expectReconciled(wallet.id);
  });

  it('processes distinct wallets in parallel without contention', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => createWallet(h, '50.00')),
    );

    await Promise.all(
      wallets.map((wallet) =>
        submit(h, commandFor(wallet, { money: brl('10.00') })),
      ),
    );

    for (const wallet of wallets) {
      expect((await walletRow(h, wallet.id))!.balance).toBe('40.00');
      await expectReconciled(wallet.id);
    }
  });

  it('is correct with three application instances sharing the database', async () => {
    const wallet = await createWallet(h, '100.00');
    const instances = [h.newInstance(), h.newInstance(), h.newInstance()];
    const command = commandFor(wallet, { money: brl('80.00') });

    const results = await Promise.all(
      instances.map((instance) =>
        instance.processTransaction.execute(command, {
          origin: TransactionOrigin.Api,
          correlationId: 'test-correlation',
        }),
      ),
    );

    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(3);
    expect((await walletRow(h, wallet.id))!.balance).toBe('20.00');
    const [counts] = await h.sql<{ debits: number }>(
      `select count(*)::int as debits from wallet_ledger_entries where direction = 'DEBIT'`,
    );
    expect(counts!.debits).toBe(1);
    await expectReconciled(wallet.id);
  });
});

describe('references', () => {
  it('parks a REFUND that arrives before its BET and applies it once the reference appears', async () => {
    const wallet = await createWallet(h, '100.00');
    const refund = commandFor(wallet, {
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'external-bet-1',
    });

    const pending = await submit(h, refund);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    await submit(
      h,
      commandFor(wallet, {
        externalTransactionId: 'external-bet-1',
        money: brl('25.00'),
      }),
    );
    h.clock.advance(6_000);

    await h.pendingReferenceWorker().tick();

    const [transaction] = await h.sql<{
      status: string;
      reference_transaction_id: string | null;
    }>(
      'select status, reference_transaction_id from wager_transactions where external_transaction_id = ?',
      [refund.externalTransactionId],
    );
    expect(transaction!.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction!.reference_transaction_id).not.toBeNull();
    expect((await walletRow(h, wallet.id))!.balance).toBe('100.00');
    await expectReconciled(wallet.id);
  });

  it('rejects a reference that never arrives once the policy is exhausted', async () => {
    const wallet = await createWallet(h, '100.00');
    const refund = commandFor(wallet, {
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'external-never',
    });
    expect((await submit(h, refund)).status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    h.clock.advance(6_000);
    await h.pendingReferenceWorker().tick();
    h.clock.advance(200_000);
    await h.pendingReferenceWorker().tick();

    const row = await transactionRow(
      h,
      (
        await h.sql<{ id: string }>(
          'select id from wager_transactions where external_transaction_id = ?',
          [refund.externalTransactionId],
        )
      )[0]!.id,
    );

    expect(row!.status).toBe(WagerTransactionStatus.Rejected);
    expect(row!.failureCode).toBe(FailureCode.ReferenceExpired);
    expect((await walletRow(h, wallet.id))!.balance).toBe('100.00');

    const [counts] = await h.sql<{ rejected_events: number }>(
      `select count(*)::int as rejected_events from outbox_messages where event_type = 'WagerTransactionRejected'`,
    );
    expect(counts!.rejected_events).toBeGreaterThanOrEqual(1);
  });

  it('parks a WIN that references a BET that has not arrived yet', async () => {
    const wallet = await createWallet(h, '100.00');
    const win = commandFor(wallet, {
      kind: WagerTransactionKind.Win,
      money: brl('25.00'),
      referenceExternalTransactionId: 'external-bet-win',
    });

    expect((await submit(h, win)).status).toBe(
      WagerTransactionStatus.PendingReference,
    );

    await submit(
      h,
      commandFor(wallet, {
        externalTransactionId: 'external-bet-win',
        money: brl('25.00'),
      }),
    );
    h.clock.advance(6_000);
    await h.pendingReferenceWorker().tick();

    const [transaction] = await h.sql<{
      status: string;
      reference_transaction_id: string | null;
    }>(
      'select status, reference_transaction_id from wager_transactions where external_transaction_id = ?',
      [win.externalTransactionId],
    );
    expect(transaction!.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction!.reference_transaction_id).not.toBeNull();
    expect((await walletRow(h, wallet.id))!.balance).toBe('100.00');
    await expectReconciled(wallet.id);
  });

  it('rejects a WIN whose reference is not a BET', async () => {
    const wallet = await createWallet(h, '100.00');
    await submit(
      h,
      commandFor(wallet, {
        kind: WagerTransactionKind.Loss,
        externalTransactionId: 'external-loss-win',
        money: brl('10.00'),
      }),
    );

    const result = await submit(
      h,
      commandFor(wallet, {
        kind: WagerTransactionKind.Win,
        money: brl('10.00'),
        referenceExternalTransactionId: 'external-loss-win',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  it('rejects a REFUND whose amount differs from the reference', async () => {
    const wallet = await createWallet(h, '100.00');
    await submit(
      h,
      commandFor(wallet, {
        externalTransactionId: 'external-bet-2',
        money: brl('25.00'),
      }),
    );

    const result = await submit(
      h,
      commandFor(wallet, {
        kind: WagerTransactionKind.Refund,
        money: brl('24.00'),
        referenceExternalTransactionId: 'external-bet-2',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.AmountMismatch);
    expect((await walletRow(h, wallet.id))!.balance).toBe('75.00');
  });

  it('rejects a REFUND without a reference and persists the rejection', async () => {
    const wallet = await createWallet(h, '100.00');
    const result = await submit(
      h,
      commandFor(wallet, {
        kind: WagerTransactionKind.Refund,
        money: brl('10.00'),
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceRequired);
    expect((await walletRow(h, wallet.id))!.balance).toBe('100.00');

    const [events] = await h.sql<{ count: number }>(
      `select count(*)::int as count from outbox_messages where event_type = 'WagerTransactionRejected'`,
    );
    expect(events!.count).toBe(1);
  });

  it('rejects a reference that points to the transaction itself as invalid input', async () => {
    const wallet = await createWallet(h, '100.00');

    await expect(
      submit(
        h,
        commandFor(wallet, {
          kind: WagerTransactionKind.Refund,
          externalTransactionId: 'self-reference',
          money: brl('10.00'),
          referenceExternalTransactionId: 'self-reference',
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidTransactionStateError);

    expect((await walletRow(h, wallet.id))!.balance).toBe('100.00');
    const [counts] = await h.sql<{ count: number }>(
      'select count(*)::int as count from wager_transactions',
    );
    expect(counts!.count).toBe(1); // only the OPENING
  });

  it('rejects a second reversal of the same reference', async () => {
    const wallet = await createWallet(h, '100.00');
    const bet = commandFor(wallet, { money: brl('25.00') });
    await submit(h, bet);

    const rollback = commandFor(wallet, {
      kind: WagerTransactionKind.Rollback,
      money: brl('25.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await submit(h, rollback)).status).toBe(
      WagerTransactionStatus.Processed,
    );

    const second = await submit(h, {
      ...rollback,
      externalTransactionId: `${rollback.externalTransactionId}-2`,
      idempotencyKey: `${rollback.idempotencyKey}-2`,
    });
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.AlreadyReversed);
    expect((await walletRow(h, wallet.id))!.balance).toBe('100.00');
  });
});

describe('business rejections', () => {
  it('distinguishes a reversal that would go negative from a normal bet rejection', async () => {
    const wallet = await createWallet(h, '100.00');
    const win = commandFor(wallet, {
      kind: WagerTransactionKind.Win,
      money: brl('100.00'),
    });
    await submit(h, win);
    await submit(h, commandFor(wallet, { money: brl('150.00') }));

    const rollback = await submit(
      h,
      commandFor(wallet, {
        kind: WagerTransactionKind.Rollback,
        money: brl('100.00'),
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect((await walletRow(h, wallet.id))!.balance).toBe('50.00');
    await expectReconciled(wallet.id);
  });

  it('rejects a transaction whose player does not own the wallet', async () => {
    const wallet = await createWallet(h, '100.00');
    const result = await submit(
      h,
      commandFor(wallet, { playerId: crypto.randomUUID() }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    expect((await walletRow(h, wallet.id))!.balance).toBe('100.00');
  });

  it('rejects a reference from another round', async () => {
    const wallet = await createWallet(h, '100.00');
    const bet = commandFor(wallet, { roundId: 'round-1', money: brl('10.00') });
    await submit(h, bet);

    const refund = await submit(
      h,
      commandFor(wallet, {
        kind: WagerTransactionKind.Refund,
        roundId: 'round-2',
        money: brl('10.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect((await walletRow(h, wallet.id))!.balance).toBe('90.00');
  });
});

describe('transactional outbox', () => {
  it('publishes pending events atomically with the financial transaction', async () => {
    await drainQueue(h.env.SQS_EVENTS_QUEUE_NAME);
    const wallet = await createWallet(h, '100.00');
    await submit(h, commandFor(wallet, { money: brl('25.00') }));

    await h.outboxPublisher().tick();

    const published = await drainQueue(h.env.SQS_EVENTS_QUEUE_NAME);
    const eventTypes = published
      .map((body) => JSON.parse(body).eventType)
      .sort((a, b) => a.localeCompare(b));
    expect(eventTypes).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);

    const [counts] = await h.sql<{ pending: number }>(
      'select count(*)::int as pending from outbox_messages where published_at is null',
    );
    expect(counts!.pending).toBe(0);
  });

  it('supports two publishers racing over the same outbox rows', async () => {
    await drainQueue(h.env.SQS_EVENTS_QUEUE_NAME);
    await createWallet(h, '100.00');
    const second = await createWallet(h, '100.00');
    await submit(h, commandFor(second, { money: brl('10.00') }));

    const first = h.outboxPublisher();
    const other = h.newInstance().outboxPublisher();
    await Promise.all([first.tick(), other.tick()]);

    const published = await drainQueue(h.env.SQS_EVENTS_QUEUE_NAME);
    expect(published).toHaveLength(6);

    const [counts] = await h.sql<{ pending: number }>(
      'select count(*)::int as pending from outbox_messages where published_at is null',
    );
    expect(counts!.pending).toBe(0);
  });

  it('reschedules a failed publish with backoff and publishes it later', async () => {
    await drainQueue(h.env.SQS_EVENTS_QUEUE_NAME);
    await createWallet(h, '100.00');

    const failingPublisher = {
      publish: async () => {
        throw new Error('broker unavailable');
      },
    };
    const failedAt = h.clock.now();
    await new OutboxPublisherWorker(
      h.uow,
      failingPublisher,
      h.clock,
      h.env,
    ).tick();

    const [failed] = await h.sql<{
      total: number;
      pending: number;
      attempts: number;
      next_attempt_at: Date;
    }>(
      `select count(*)::int as total,
              count(*) filter (where published_at is null)::int as pending,
              max(attempts)::int as attempts,
              min(next_attempt_at) as next_attempt_at
         from outbox_messages`,
    );
    expect(failed!.total).toBe(2);
    expect(failed!.pending).toBe(2);
    expect(failed!.attempts).toBe(1);
    expect(new Date(failed!.next_attempt_at).toISOString()).toBe(
      new Date(failedAt.getTime() + 1_000).toISOString(),
    );

    // Still in backoff: nothing is published.
    await h.outboxPublisher().tick();
    expect(await queueDepth(h.env.SQS_EVENTS_QUEUE_NAME)).toBe(0);

    h.clock.advance(2_000);
    await h.outboxPublisher().tick();

    const [published] = await h.sql<{ pending: number }>(
      'select count(*) filter (where published_at is null)::int as pending from outbox_messages',
    );
    expect(published!.pending).toBe(0);
    expect(await drainQueue(h.env.SQS_EVENTS_QUEUE_NAME)).toHaveLength(2);
  });

  it('publishes after a restart when the process died before publishing', async () => {
    await drainQueue(h.env.SQS_EVENTS_QUEUE_NAME);
    const wallet = await createWallet(h, '100.00');
    await submit(h, commandFor(wallet, { money: brl('10.00') }));

    // Nothing published yet: the "old process" died right after the commit.
    expect(await queueDepth(h.env.SQS_EVENTS_QUEUE_NAME)).toBe(0);

    const restarted = await h.newOrm();
    try {
      const instance = new MikroOrmUnitOfWork(restarted);
      const worker = new OutboxPublisherWorker(
        instance,
        new SqsEventPublisher(h.sqs, h.queues),
        h.clock,
        h.env,
      );
      await worker.tick();
    } finally {
      await restarted.close(true);
    }

    const published = await drainQueue(h.env.SQS_EVENTS_QUEUE_NAME);
    expect(published.map((body) => JSON.parse(body).eventType)).toContain(
      'WagerTransactionProcessed',
    );
    const [counts] = await h.sql<{ pending: number }>(
      'select count(*)::int as pending from outbox_messages where published_at is null',
    );
    expect(counts!.pending).toBe(0);
  });
});

describe('sqs consumer', () => {
  let consumer: SqsConsumer;

  beforeAll(async () => {
    consumer = new SqsConsumer(
      h.sqs,
      h.queues,
      h.processTransaction,
      h.clock,
      h.env,
    );
    await consumer.onApplicationBootstrap();
  }, 60_000);

  afterAll(async () => {
    await consumer.onApplicationShutdown();
  });

  it('processes a valid message, deduplicates redelivery and dead-letters bad input', async () => {
    await drainQueue(h.env.SQS_QUEUE_NAME);
    await drainQueue(h.env.SQS_DLQ_NAME);

    const wallet = await createWallet(h, '100.00');
    const messageId = `msg-${crypto.randomUUID()}`;
    const body = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: h.clock.now().toISOString(),
      data: {
        ...commandFor(wallet, { money: brl('25.00') }),
        money: { amount: '25.00', currency: 'BRL' },
      },
    };
    await sendRaw(h.env.SQS_QUEUE_NAME, JSON.stringify(body), wallet.id);

    let row = await walletRow(h, wallet.id);
    for (
      let attempt = 0;
      attempt < 30 && row!.balance !== '75.00';
      attempt += 1
    ) {
      await wait(500);
      row = await walletRow(h, wallet.id);
    }
    expect(row!.balance).toBe('75.00');

    // Redelivery of the same message id must not debit twice.
    await sendRaw(h.env.SQS_QUEUE_NAME, JSON.stringify(body), wallet.id);
    await wait(2_500);
    expect((await walletRow(h, wallet.id))!.balance).toBe('75.00');

    const [inbox] = await h.sql<{ count: number; processed: number }>(
      `select count(*)::int as count,
              count(*) filter (where processed_at is not null)::int as processed
         from inbox_messages`,
    );
    expect(inbox).toEqual({ count: 1, processed: 1 });

    // Invalid payload and unknown wallet are permanent failures -> DLQ.
    await sendRaw(h.env.SQS_QUEUE_NAME, 'not-json', 'invalid');
    await sendRaw(
      h.env.SQS_QUEUE_NAME,
      JSON.stringify({
        ...body,
        messageId: `msg-${crypto.randomUUID()}`,
        data: {
          ...body.data,
          walletId: crypto.randomUUID(),
          idempotencyKey: 'new-key',
          externalTransactionId: 'new-ext',
        },
      }),
      'missing-wallet',
    );

    let dlq = 0;
    for (let attempt = 0; attempt < 40 && dlq < 2; attempt += 1) {
      await wait(500);
      dlq = await queueDepth(h.env.SQS_DLQ_NAME);
    }
    expect(dlq).toBeGreaterThanOrEqual(2);
    await expectReconciled(wallet.id);
  }, 120_000);
});

describe('sqs retries', () => {
  it('redelivers transient failures until the attempt limit and then dead-letters', async () => {
    await drainQueue(h.env.SQS_QUEUE_NAME);
    await drainQueue(h.env.SQS_DLQ_NAME);

    const failingUseCase = {
      execute: async () => {
        throw new Error('database unavailable');
      },
    } as unknown as ProcessWagerTransactionUseCase;

    const consumer = new SqsConsumer(
      h.sqs,
      h.queues,
      failingUseCase,
      h.clock,
      h.env,
    );
    await consumer.onApplicationBootstrap();

    try {
      const wallet = await createWallet(h, '100.00');
      await sendRaw(
        h.env.SQS_QUEUE_NAME,
        JSON.stringify({
          messageId: `msg-${crypto.randomUUID()}`,
          type: 'WagerTransactionRequested',
          occurredAt: h.clock.now().toISOString(),
          data: {
            ...commandFor(wallet, { money: brl('10.00') }),
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
        wallet.id,
      );

      let dlq = 0;
      for (let attempt = 0; attempt < 60 && dlq === 0; attempt += 1) {
        await wait(500);
        dlq = await queueDepth(h.env.SQS_DLQ_NAME);
      }
      expect(dlq).toBeGreaterThanOrEqual(1);
      // No financial effect: the use case always failed.
      expect((await walletRow(h, wallet.id))!.balance).toBe('100.00');
      await expectReconciled(wallet.id);
    } finally {
      await consumer.onApplicationShutdown();
    }
  }, 120_000);
});

describe('http api', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = h.env.DATABASE_URL;
    process.env.SQS_ENDPOINT = h.env.SQS_ENDPOINT;
    process.env.SQS_CONSUMER_ENABLED = 'false';
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
    process.env.QUEUE_AUTO_CREATE = 'false';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  async function createWalletViaHttp(): Promise<{
    id: string;
    playerId: string;
  }> {
    const playerId = crypto.randomUUID();
    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    return { id: response.body.id, playerId };
  }

  it('creates a wallet and rejects a duplicate as 409', async () => {
    const wallet = await createWalletViaHttp();
    expect(wallet.id).toMatch(/^[0-9a-f-]{36}$/);

    const response = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: wallet.playerId,
        initialBalance: { amount: '1.00', currency: 'BRL' },
      })
      .expect(409);
    expect(response.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('distinguishes processed, replay, conflict, rejection, pending and invalid input', async () => {
    const wallet = await createWalletViaHttp();
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'http-1',
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const processed = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:http-1')
      .send(body)
      .expect(201);
    expect(processed.body).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: false,
      balance: { amount: '75.00', currency: 'BRL' },
    });

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:http-1')
      .send(body)
      .expect(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(processed.body.transactionId);

    const conflict = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:http-1')
      .send({ ...body, money: { amount: '30.00', currency: 'BRL' } })
      .expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const missingKey = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send({ ...body, externalTransactionId: 'http-2' })
      .expect(400);
    expect(missingKey.body.error.code).toBe('INVALID_PAYLOAD');

    const opening = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:http-opening')
      .send({ ...body, externalTransactionId: 'http-opening', kind: 'OPENING' })
      .expect(400);
    expect(opening.body.error.code).toBe('INVALID_PAYLOAD');

    const rejected = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:http-big')
      .send({
        ...body,
        externalTransactionId: 'http-big',
        money: { amount: '1000.00', currency: 'BRL' },
      })
      .expect(422);
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    const pending = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:http-refund')
      .send({
        ...body,
        externalTransactionId: 'http-refund',
        kind: 'REFUND',
        referenceExternalTransactionId: 'missing-bet',
      })
      .expect(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    const unknownWallet = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:http-missing')
      .send({
        ...body,
        externalTransactionId: 'http-missing',
        walletId: crypto.randomUUID(),
      })
      .expect(404);
    expect(unknownWallet.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('exposes queries, pagination, reconciliation, health and metrics', async () => {
    const wallet = await createWalletViaHttp();
    for (let index = 0; index < 3; index += 1) {
      await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', `provider-a:page-${index}`)
        .send({
          providerId: 'provider-a',
          externalTransactionId: `page-${index}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-page',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        })
        .expect(201);
    }

    const walletResponse = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .expect(200);
    expect(walletResponse.body.version).toBe(4);

    const firstPage = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger?limit=2`)
      .expect(200);
    expect(firstPage.body.entries).toHaveLength(2);
    expect(firstPage.body.nextCursor).toBeTypeOf('string');

    const secondPage = await request(app.getHttpServer())
      .get(
        `/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
      )
      .expect(200);
    expect(secondPage.body.entries).toHaveLength(2);
    expect(secondPage.body.nextCursor).toBeNull();

    const reconciliation = await request(app.getHttpServer())
      .post(`/wallets/${wallet.id}/reconciliation`)
      .expect(200);
    expect(reconciliation.body).toMatchObject({
      consistent: true,
      checkedEntries: 4,
    });

    const byId = await request(app.getHttpServer())
      .get('/wagering/transactions/' + firstPage.body.entries[0].transactionId)
      .expect(200);
    expect(byId.body.status).toBe('PROCESSED');

    const byProvider = await request(app.getHttpServer())
      .get('/providers/provider-a/wagering/transactions/page-1')
      .expect(200);
    expect(byProvider.body.externalTransactionId).toBe('page-1');

    await request(app.getHttpServer())
      .get(`/wallets/${crypto.randomUUID()}`)
      .expect(404);
    await request(app.getHttpServer()).get('/wallets/not-a-uuid').expect(400);

    const live = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);
    expect(live.body.status).toBe('ok');

    const ready = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'up' });

    const metrics = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    expect(metrics.text).toContain('wager_transactions_total');
  });
});

describe('reconciliation', () => {
  it('walks the ledger cursor page by page and keeps balances consistent', async () => {
    const wallet = await createWallet(h, '100.00');
    for (let index = 0; index < 5; index += 1) {
      await submit(h, commandFor(wallet, { money: brl('1.00') }));
    }

    const ledger = new GetWalletLedgerUseCase(h.uow);
    const seen: string[] = [];
    let cursor: LedgerCursor | null = null;
    do {
      const page = await ledger.execute(wallet.id, cursor, 2);
      seen.push(...page.entries.map((entry) => entry.id));
      cursor =
        page.nextCursor === null ? null : decodeLedgerCursor(page.nextCursor);
    } while (cursor !== null);

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    await expectReconciled(wallet.id);
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
