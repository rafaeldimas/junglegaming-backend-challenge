import { Money } from '../../shared/domain/money.js';
import { WalletBalanceChanged } from './events.js';
import { InboxMessage } from './inbox-message.js';
import { OutboxMessage } from './outbox-message.js';
import type { EventContext } from './integration-event.js';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry.js';
import { Wallet } from '../../wallets/domain/wallet.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const context: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  occurredAt: NOW,
};

function wallet(): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    openedAt: NOW,
  });
}

function event(): WalletBalanceChanged {
  const w = wallet();
  const entry = w.debit(Money.from({ amount: '10.00', currency: 'BRL' }), {
    entryId: 'entry-1',
    transactionId: 'tx-1',
    at: NOW,
  });
  return WalletBalanceChanged.from(w, entry, context);
}

describe('OutboxMessage', () => {
  it('enqueues the serialized envelope with a zero attempt count', () => {
    const outbox = OutboxMessage.enqueue(event());

    expect(outbox.id).toBe('event-1');
    expect(outbox.aggregateId).toBe('wallet-1');
    expect(outbox.eventType).toBe('WalletBalanceChanged');
    expect(outbox.occurredAt).toBe(NOW);
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(NOW)).toBe(true);
    expect(outbox.payload).toMatchObject({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: NOW.toISOString(),
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('marks published rows as no longer pending or due', () => {
    const outbox = OutboxMessage.enqueue(event());
    outbox.markPublished(NOW);

    expect(outbox.publishedAt).toBe(NOW);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date('2027-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('schedules retries with capped exponential backoff', () => {
    const outbox = OutboxMessage.enqueue(event());

    outbox.scheduleRetry(NOW);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.toISOString()).toBe(
      '2026-01-01T12:00:01.000Z',
    );
    expect(outbox.isDue(new Date('2026-01-01T12:00:00.500Z'))).toBe(false);

    outbox.scheduleRetry(NOW);
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt?.toISOString()).toBe(
      '2026-01-01T12:00:02.000Z',
    );

    for (let index = 0; index < 10; index += 1) {
      outbox.scheduleRetry(NOW);
    }
    expect(outbox.attempts).toBe(12);
    expect(outbox.nextAttemptAt?.toISOString()).toBe(
      '2026-01-01T12:01:00.000Z',
    );
    expect(outbox.isDue(new Date('2026-01-01T12:01:01.000Z'))).toBe(true);
  });
});

describe('InboxMessage', () => {
  it('tracks reception and processing', () => {
    const inbox = InboxMessage.receive({
      id: 'inbox-1',
      messageId: 'msg-1',
      consumerName: 'sqs:wager-transactions',
      payloadHash: 'a'.repeat(64),
      receivedAt: NOW,
    });

    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();

    inbox.markProcessed(NOW);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toBe(NOW);
  });
});
