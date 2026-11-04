import { InvalidMoneyError, InvalidTransactionStateError } from '../../shared/domain/errors.js';
import { Money } from '../../shared/domain/money.js';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry.js';
import { FailureCode } from './failure-code.js';
import {
  CreateWagerTransactionProps,
  TransactionOrigin,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

const AT = new Date('2026-01-01T00:00:00.000Z');

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    origin: TransactionOrigin.Api,
    correlationId: 'corr-1',
    createdAt: AT,
    ...overrides,
  };
}

describe('WagerTransaction', () => {
  it('is born PENDING', () => {
    const transaction = WagerTransaction.create(props());

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.pendingReferenceAttempts).toBe(0);
  });

  it('requires a reference for REFUND and ROLLBACK', () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidTransactionStateError);
      expect(() =>
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'external-0' })),
      ).not.toThrow();
    }
  });

  it('keeps OPENING internal and rejects external OPENING', () => {
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Opening })),
    ).toThrow(InvalidTransactionStateError);
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Opening, origin: TransactionOrigin.Internal })),
    ).not.toThrow();
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Bet, origin: TransactionOrigin.Internal })),
    ).toThrow(InvalidTransactionStateError);
  });

  it('rejects a self reference and invalid amounts', () => {
    expect(() =>
      WagerTransaction.create(
        props({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'external-1',
        }),
      ),
    ).toThrow(InvalidTransactionStateError);

    expect(() =>
      WagerTransaction.create(props({ money: Money.from({ amount: '0.00', currency: 'BRL' }) })),
    ).toThrow(InvalidMoneyError);
  });

  it('marks processed with the observed balance and clears the retry schedule', () => {
    const transaction = WagerTransaction.create(props());
    transaction.markPendingReference(AT);
    transaction.scheduleReferenceRetry(new Date('2026-01-01T00:00:05.000Z'), AT);
    transaction.markProcessed(undefined, AT, Money.from({ amount: '90.00', currency: 'BRL' }), 2);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toBe(AT);
    expect(transaction.balanceAfter?.toJSON().amount).toBe('90.00');
    expect(transaction.walletVersionAfter).toBe(2);
    expect(transaction.nextReferenceRetryAt).toBeUndefined();
    expect(transaction.isTerminal()).toBe(true);
  });

  it('treats PROCESSED, REJECTED and FAILED as terminal', () => {
    const processed = WagerTransaction.create(props());
    processed.markProcessed(undefined, AT);
    const rejected = WagerTransaction.createRejected(props(), FailureCode.InsufficientFunds);
    const failed = WagerTransaction.create(props());
    failed.fail(FailureCode.InfraPermanentFailure, AT);

    for (const terminal of [processed, rejected, failed]) {
      expect(terminal.isTerminal()).toBe(true);
    }
    expect(() => processed.reject(FailureCode.InsufficientFunds, AT)).toThrow(InvalidTransactionStateError);
    expect(() => rejected.markProcessed(undefined, AT)).toThrow(InvalidTransactionStateError);
    expect(() => failed.fail(FailureCode.WalletNotFound, AT)).toThrow(InvalidTransactionStateError);
    expect(() => failed.markPendingReference(AT)).toThrow(InvalidTransactionStateError);
  });

  it('reject and fail record the failure code', () => {
    const rejected = WagerTransaction.create(props());
    rejected.reject(FailureCode.InsufficientFunds, AT);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const failed = WagerTransaction.create(props());
    failed.fail(FailureCode.InfraPermanentFailure, AT);
    expect(failed.failureCode).toBe(FailureCode.InfraPermanentFailure);
    expect(failed.status).toBe(WagerTransactionStatus.Failed);
  });

  it('only balance-affecting kinds and non-rejected transactions move money', () => {
    const loss = WagerTransaction.create(props({ kind: WagerTransactionKind.Loss }));
    expect(loss.affectsBalance()).toBe(false);

    const bet = WagerTransaction.create(props());
    expect(bet.affectsBalance()).toBe(true);

    const rejectedBet = WagerTransaction.create(props());
    rejectedBet.reject(FailureCode.InsufficientFunds, AT);
    expect(rejectedBet.affectsBalance()).toBe(false);
  });

  it('derives the ledger direction, inverting it for ROLLBACK', () => {
    const bet = WagerTransaction.create(props());
    const win = WagerTransaction.create(props({ kind: WagerTransactionKind.Win, externalTransactionId: 'e2' }));
    const refund = WagerTransaction.create(
      props({
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'e3',
        referenceExternalTransactionId: 'external-1',
      }),
    );
    const rollback = WagerTransaction.create(
      props({
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: 'e4',
        referenceExternalTransactionId: 'external-1',
      }),
    );

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() =>
      rollback.ledgerDirectionFor(
        WagerTransaction.create(props({ kind: WagerTransactionKind.Loss, externalTransactionId: 'e5' })),
      ),
    ).toThrow(InvalidTransactionStateError);
  });

  it('detects payload divergence for the same idempotency key', () => {
    const transaction = WagerTransaction.create(props());
    expect(transaction.matchesPayload('a'.repeat(64))).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });

  it('rehydrates terminal state without revalidating', () => {
    const transaction = WagerTransaction.rehydrate({
      ...props(),
      status: WagerTransactionStatus.Processed,
      balanceAfter: Money.from({ amount: '90.00', currency: 'BRL' }),
      walletVersionAfter: 2,
      pendingReferenceAttempts: 3,
      processedAt: AT,
      updatedAt: AT,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.balanceAfter?.toJSON().amount).toBe('90.00');
    expect(transaction.pendingReferenceAttempts).toBe(3);
  });
});
