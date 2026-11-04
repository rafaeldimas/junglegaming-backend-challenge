import { FailureCode } from '../domain/failure-code.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { InsufficientFundsError } from '../../shared/domain/errors.js';
import { Money } from '../../shared/domain/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../wallets/domain/wallet-ledger-entry.js';
import { Wallet } from '../../wallets/domain/wallet.js';
import { TransactionContext } from '../../platform/database/transaction-context.js';
import type { Clock } from '../../shared/domain/clock.js';
import type { IdGenerator } from '../../shared/domain/id-generator.js';
import { OutboxMessage } from '../../messaging/domain/outbox-message.js';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../messaging/domain/events.js';
import { EventContext } from '../../messaging/domain/integration-event.js';
import { metrics } from '../../platform/observability/metrics.js';

export interface PendingReferencePolicy {
  maxAttempts: number;
  ttlMs: number;
}

export interface ApplyOptions {
  correlationId: string;
  causationId?: string;
  /** `initial` on ingestion, `retry` from the scheduled worker. */
  referencePolicy: 'initial' | 'retry';
}

export interface ApplyOutcome {
  status: WagerTransactionStatus;
  balance: Money | null;
  failureCode?: FailureCode;
}

const REFERENCE_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

/**
 * Applies an already-persisted transaction to a wallet and writes the ledger
 * entry, the updated transaction and the outbox rows. Shared by the HTTP/SQS
 * ingestion path and by the PENDING_REFERENCE worker, so both behave the same.
 *
 * Must run inside a Unit of Work transaction: the wallet is locked with
 * `SELECT ... FOR UPDATE` before any balance read.
 */
export class WagerTransactionApplier {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly pendingPolicy: PendingReferencePolicy,
  ) {}

  async apply(
    ctx: TransactionContext,
    transaction: WagerTransaction,
    options: ApplyOptions,
  ): Promise<ApplyOutcome> {
    const now = this.clock.now();

    const wallet = await ctx.wallets.findById(transaction.walletId, {
      forUpdate: true,
    });
    if (wallet === null) {
      return this.reject(
        ctx,
        transaction,
        FailureCode.WalletNotFound,
        null,
        options,
        now,
      );
    }
    if (wallet.playerId !== transaction.playerId) {
      return this.reject(
        ctx,
        transaction,
        FailureCode.PlayerWalletMismatch,
        wallet,
        options,
        now,
      );
    }
    if (wallet.currency !== transaction.money.currency) {
      return this.reject(
        ctx,
        transaction,
        FailureCode.CurrencyMismatch,
        wallet,
        options,
        now,
      );
    }

    let resolvedReference: WagerTransaction | undefined;

    // REFUND/ROLLBACK require a reference; WIN may carry one. Any reference that
    // is present is resolved and validated with the same rules.
    if (transaction.referenceExternalTransactionId !== undefined) {
      const reference = await ctx.wagerTransactions.findByProviderExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId!,
      );

      if (
        reference === null ||
        !reference.isTerminal() ||
        reference.status === WagerTransactionStatus.PendingReference
      ) {
        return this.handleUnresolvedReference(
          ctx,
          transaction,
          wallet,
          options,
          now,
        );
      }

      if (reference.status !== WagerTransactionStatus.Processed) {
        return this.reject(
          ctx,
          transaction,
          FailureCode.ReferenceNotSuccessful,
          wallet,
          options,
          now,
        );
      }

      const referenceFailure = this.validateReference(transaction, reference);
      if (referenceFailure !== null) {
        return this.reject(
          ctx,
          transaction,
          referenceFailure,
          wallet,
          options,
          now,
        );
      }

      const alreadyReversed = await ctx.wagerTransactions.findProcessedReversal(
        reference.id,
        transaction.kind,
      );
      if (alreadyReversed !== null) {
        return this.reject(
          ctx,
          transaction,
          FailureCode.AlreadyReversed,
          wallet,
          options,
          now,
        );
      }

      resolvedReference = reference;
    }

    const kind = transaction.kind;
    if (kind === WagerTransactionKind.Opening) {
      // OPENING is only created by CreateWalletUseCase, never here.
      return this.reject(
        ctx,
        transaction,
        FailureCode.UnsupportedKind,
        wallet,
        options,
        now,
      );
    }

    let entry: WalletLedgerEntry | undefined;
    try {
      entry = this.moveMoney(wallet, transaction, resolvedReference, now);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        const code =
          kind === WagerTransactionKind.Rollback
            ? FailureCode.ReversalInsufficientFunds
            : FailureCode.InsufficientFunds;
        return this.reject(ctx, transaction, code, wallet, options, now);
      }
      throw error;
    }

    transaction.markProcessed(
      resolvedReference?.id,
      now,
      wallet.balance,
      wallet.version,
    );

    if (entry !== undefined) {
      await ctx.wallets.update(wallet);
      await ctx.ledger.insert(entry);
    }
    await ctx.wagerTransactions.update(transaction);

    await this.emitProcessed(ctx, transaction, wallet, entry, options, now);
    metrics.recordTransaction(WagerTransactionStatus.Processed, kind);
    return {
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance,
    };
  }

  /**
   * Persists an ingress-level rejection that does not need to touch a wallet
   * (for example a REFUND without a reference). Still writes the outbox event.
   */
  async rejectBeforeWallet(
    ctx: TransactionContext,
    transaction: WagerTransaction,
    code: FailureCode,
    options: ApplyOptions,
  ): Promise<ApplyOutcome> {
    const now = this.clock.now();
    // The transaction was built already rejected by `createRejected` (the
    // rejection happens at creation because the reference is missing).
    if (!transaction.isTerminal()) {
      transaction.reject(code, now);
    }
    await ctx.wagerTransactions.update(transaction);
    await ctx.outbox.insertMany([
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(
          transaction,
          this.eventContext(options, now),
        ),
      ),
    ]);
    metrics.recordTransaction(
      WagerTransactionStatus.Rejected,
      transaction.kind,
    );
    return {
      status: WagerTransactionStatus.Rejected,
      balance: null,
      failureCode: code,
    };
  }

  private moveMoney(
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    now: Date,
  ): WalletLedgerEntry | undefined {
    if (!transaction.affectsBalance()) {
      return undefined;
    }

    const movement = {
      entryId: this.ids.next(),
      transactionId: transaction.id,
      at: now,
    };

    switch (transaction.kind) {
      case WagerTransactionKind.Bet:
        return wallet.debit(transaction.money, movement);
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return wallet.credit(transaction.money, movement);
      case WagerTransactionKind.Rollback: {
        const direction = transaction.ledgerDirectionFor(reference);
        return direction === LedgerDirection.Debit
          ? wallet.debit(transaction.money, movement)
          : wallet.credit(transaction.money, movement);
      }
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Opening:
        throw new Error('OPENING must be handled by CreateWalletUseCase');
    }
  }

  private validateReference(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): FailureCode | null {
    if (
      (transaction.kind === WagerTransactionKind.Refund ||
        transaction.kind === WagerTransactionKind.Win) &&
      reference.kind !== WagerTransactionKind.Bet
    ) {
      return FailureCode.InvalidReferenceKind;
    }
    if (
      transaction.kind === WagerTransactionKind.Rollback &&
      !reference.isRollbackable()
    ) {
      return FailureCode.InvalidReferenceKind;
    }
    if (reference.providerId !== transaction.providerId) {
      return FailureCode.ReferenceMismatch;
    }
    if (
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (reference.money.currency !== transaction.money.currency) {
      return FailureCode.ReferenceMismatch;
    }
    if (reference.roundId !== transaction.roundId) {
      return FailureCode.ReferenceMismatch;
    }
    if (!reference.money.equals(transaction.money)) {
      return FailureCode.AmountMismatch;
    }
    return null;
  }

  private async handleUnresolvedReference(
    ctx: TransactionContext,
    transaction: WagerTransaction,
    wallet: Wallet,
    options: ApplyOptions,
    now: Date,
  ): Promise<ApplyOutcome> {
    const attempt = transaction.pendingReferenceAttempts + 1;
    const age = now.getTime() - transaction.createdAt.getTime();
    const ttlExceeded = age > this.pendingPolicy.ttlMs;

    if (
      options.referencePolicy === 'retry' &&
      (attempt > this.pendingPolicy.maxAttempts || ttlExceeded)
    ) {
      const code = ttlExceeded
        ? FailureCode.ReferenceExpired
        : FailureCode.ReferenceNotFound;
      return this.reject(ctx, transaction, code, wallet, options, now);
    }

    const nextAttemptAt = new Date(now.getTime() + backoffFor(attempt));
    transaction.scheduleReferenceRetry(nextAttemptAt, now);
    await ctx.wagerTransactions.update(transaction);

    const eventContext = this.eventContext(options, now);
    await ctx.outbox.insertMany([
      OutboxMessage.enqueue(
        WagerTransactionPendingReference.from(
          transaction,
          attempt,
          nextAttemptAt,
          eventContext,
        ),
      ),
    ]);
    metrics.recordTransaction(
      WagerTransactionStatus.PendingReference,
      transaction.kind,
    );

    return {
      status: WagerTransactionStatus.PendingReference,
      balance: wallet.balance,
    };
  }

  private async reject(
    ctx: TransactionContext,
    transaction: WagerTransaction,
    code: FailureCode,
    wallet: Wallet | null,
    options: ApplyOptions,
    now: Date,
  ): Promise<ApplyOutcome> {
    const balance = wallet?.balance;
    transaction.reject(code, now, balance, wallet?.version);
    await ctx.wagerTransactions.update(transaction);

    const eventContext = this.eventContext(options, now);
    await ctx.outbox.insertMany([
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(transaction, eventContext),
      ),
    ]);
    metrics.recordTransaction(
      WagerTransactionStatus.Rejected,
      transaction.kind,
    );

    return {
      status: WagerTransactionStatus.Rejected,
      balance: balance ?? null,
      failureCode: code,
    };
  }

  private async emitProcessed(
    ctx: TransactionContext,
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    options: ApplyOptions,
    now: Date,
  ): Promise<void> {
    const messages = [
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(
          transaction,
          this.eventContext(options, now),
        ),
      ),
    ];
    if (entry !== undefined) {
      messages.push(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(
            wallet,
            entry,
            this.eventContext(options, now),
          ),
        ),
      );
    }
    await ctx.outbox.insertMany(messages);
  }

  private eventContext(options: ApplyOptions, occurredAt: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: options.correlationId,
      causationId: options.causationId,
      occurredAt,
    };
  }
}

function backoffFor(attempt: number): number {
  const index = Math.min(
    Math.max(attempt - 1, 0),
    REFERENCE_BACKOFF_MS.length - 1,
  );
  return REFERENCE_BACKOFF_MS[index]!;
}
