import {
  TransactionOrigin,
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { FailureCode } from '../domain/failure-code.js';
import {
  canonicalWagerPayload,
  hashWagerPayload,
} from '../domain/canonical-payload.js';
import { Money } from '../../shared/domain/money.js';
import { InvalidTransactionStateError } from '../../shared/domain/errors.js';
import {
  UnitOfWork,
  TransactionContext,
} from '../../platform/database/transaction-context.js';
import { Clock } from '../../shared/domain/clock.js';
import { IdGenerator } from '../../shared/domain/id-generator.js';
import { InboxMessage } from '../../messaging/domain/inbox-message.js';
import { metrics } from '../../platform/observability/metrics.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../platform/errors/application-error.js';
import { isUniqueViolation } from '../../platform/database/unit-of-work.js';
import { WagerTransactionCommand } from './wager-command.js';
import { WagerTransactionApplier } from './wager-transaction-applier.js';
import { logger } from '../../platform/logging/logger.js';
import { enrichLogContext } from '../../platform/logging/log-context.js';

export interface InboxDescriptor {
  consumerName: string;
  messageId: string;
  receivedAt: Date;
}

export interface ProcessWagerTransactionOptions {
  origin: TransactionOrigin.Api | TransactionOrigin.Sqs;
  correlationId: string;
  inbox?: InboxDescriptor;
}

export interface ProcessWagerTransactionResult {
  transactionId: string | null;
  status: WagerTransactionStatus;
  balance: Money | null;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  duplicateMessage?: boolean;
}

/**
 * Single ingestion use case shared by the HTTP endpoint and the SQS consumer.
 *
 * One transaction covers: inbox insert (SQS only), idempotency lookup, the new
 * transaction row, wallet + ledger update and outbox rows.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly applier: WagerTransactionApplier,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    command: WagerTransactionCommand,
    options: ProcessWagerTransactionOptions,
  ): Promise<ProcessWagerTransactionResult> {
    const payloadHash = hashWagerPayload(
      canonicalWagerPayload({
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      }),
    );

    const startedAt = performance.now();

    try {
      const result = await this.uow.execute((ctx) =>
        this.run(ctx, command, payloadHash, options),
      );
      metrics.processingLatency.observe(
        { kind: command.kind },
        (performance.now() - startedAt) / 1000,
      );
      enrichLogContext({ transactionId: result.transactionId ?? undefined });
      return result;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Two concurrent requests with the same key: the loser re-reads the winner.
      const result = await this.uow.execute((ctx) =>
        this.resolveUniqueConflict(ctx, command, payloadHash, options),
      );
      metrics.processingLatency.observe(
        { kind: command.kind },
        (performance.now() - startedAt) / 1000,
      );
      return result;
    }
  }

  private async run(
    ctx: TransactionContext,
    command: WagerTransactionCommand,
    payloadHash: string,
    options: ProcessWagerTransactionOptions,
  ): Promise<ProcessWagerTransactionResult> {
    const now = this.clock.now();

    enrichLogContext({
      walletId: command.walletId,
      providerId: command.providerId,
      messageId: options.inbox?.messageId,
    });

    if (options.inbox !== undefined) {
      const received = InboxMessage.receive({
        id: this.ids.next(),
        messageId: options.inbox.messageId,
        consumerName: options.inbox.consumerName,
        payloadHash,
        receivedAt: options.inbox.receivedAt,
      });
      const won = await ctx.inbox.tryInsert(received);
      if (!won) {
        metrics.inboxDuplicates.inc();
        logger.debug(
          { messageId: options.inbox.messageId },
          'inbox duplicate message ignored',
        );
        const existing = await ctx.wagerTransactions.findByIdempotencyKey(
          command.providerId,
          command.idempotencyKey,
        );
        return existing === null
          ? {
              transactionId: null,
              status: WagerTransactionStatus.Pending,
              balance: null,
              idempotentReplay: true,
              duplicateMessage: true,
            }
          : this.replay(existing, true, true);
      }
    }

    const existing = await this.findExisting(ctx, command, payloadHash);
    if (existing !== null) {
      return existing;
    }

    // The wallet id is a foreign key, so an unknown wallet is a missing
    // resource rather than a persisted business rejection (see ARCHITECTURE.md).
    const wallet = await ctx.wallets.findById(command.walletId);
    if (wallet === null) {
      throw new WalletNotFoundError(command.walletId);
    }

    const transaction = await this.createOrReject(
      ctx,
      command,
      payloadHash,
      options,
      now,
    );
    if (transaction.status === WagerTransactionStatus.Rejected) {
      if (options.inbox !== undefined) {
        await ctx.inbox.markProcessed(
          options.inbox.consumerName,
          options.inbox.messageId,
          this.clock.now(),
        );
      }
      return {
        transactionId: transaction.id,
        status: WagerTransactionStatus.Rejected,
        balance: transaction.balanceAfter ?? null,
        idempotentReplay: false,
        failureCode: transaction.failureCode,
      };
    }

    const outcome = await this.applier.apply(ctx, transaction, {
      correlationId: options.correlationId,
      causationId: options.inbox?.messageId,
      referencePolicy: 'initial',
    });

    if (options.inbox !== undefined) {
      await ctx.inbox.markProcessed(
        options.inbox.consumerName,
        options.inbox.messageId,
        this.clock.now(),
      );
    }

    return {
      transactionId: transaction.id,
      status: outcome.status,
      balance: outcome.balance,
      idempotentReplay: false,
      failureCode: outcome.failureCode,
    };
  }

  private async resolveUniqueConflict(
    ctx: TransactionContext,
    command: WagerTransactionCommand,
    payloadHash: string,
    _options: ProcessWagerTransactionOptions,
  ): Promise<ProcessWagerTransactionResult> {
    const existing = await this.findExisting(ctx, command, payloadHash);
    if (existing !== null) {
      return existing;
    }

    // A unique constraint other than the idempotency keys fired (for example
    // the one-reversal-per-kind index). The client must retry and will then get
    // the deterministic ALREADY_REVERSED / conflict answer.
    throw new IdempotencyConflictError(
      'Concurrent transaction conflict, retry the request',
    );
  }

  /**
   * Resolves an already-known request. The idempotency key is the source of
   * truth, but under concurrency the winner can commit between the two
   * lookups, or the unique violation can be raised by the external-id index.
   * The row found by external id is therefore inspected: if it carries the
   * same idempotency key it is the same request and the answer is a replay.
   */
  private async findExisting(
    ctx: TransactionContext,
    command: WagerTransactionCommand,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult | null> {
    const byKey = await ctx.wagerTransactions.findByIdempotencyKey(
      command.providerId,
      command.idempotencyKey,
    );
    if (byKey !== null) {
      return this.replayOrConflict(byKey, payloadHash);
    }

    const byExternalId = await ctx.wagerTransactions.findByProviderExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (byExternalId === null) {
      return null;
    }
    if (byExternalId.idempotencyKey === command.idempotencyKey) {
      return this.replayOrConflict(byExternalId, payloadHash);
    }
    throw new ExternalTransactionConflictError(
      `External transaction ${command.externalTransactionId} is already known under another idempotency key`,
    );
  }

  private replayOrConflict(
    transaction: WagerTransaction,
    payloadHash: string,
  ): ProcessWagerTransactionResult {
    if (!transaction.matchesPayload(payloadHash)) {
      metrics.idempotencyConflicts.inc();
      throw new IdempotencyConflictError(
        `Idempotency key ${transaction.idempotencyKey} was already used with a different payload`,
        { transactionId: transaction.id },
      );
    }
    metrics.idempotentReplays.inc();
    return this.replay(transaction, true, false);
  }

  private async createOrReject(
    ctx: TransactionContext,
    command: WagerTransactionCommand,
    payloadHash: string,
    options: ProcessWagerTransactionOptions,
    now: Date,
  ): Promise<WagerTransaction> {
    const props = {
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      origin: options.origin,
      correlationId: options.correlationId,
      createdAt: now,
    };

    try {
      const transaction = WagerTransaction.create(props);
      await ctx.wagerTransactions.insert(transaction);
      return transaction;
    } catch (error) {
      if (!(error instanceof InvalidTransactionStateError)) {
        throw error;
      }
      const code =
        command.referenceExternalTransactionId === undefined
          ? FailureCode.ReferenceRequired
          : FailureCode.InvalidReference;
      const transaction = WagerTransaction.createRejected(props, code);
      await ctx.wagerTransactions.insert(transaction);
      await this.applier.rejectBeforeWallet(ctx, transaction, code, {
        correlationId: options.correlationId,
        causationId: options.inbox?.messageId,
        referencePolicy: 'initial',
      });
      return transaction;
    }
  }

  private replay(
    transaction: WagerTransaction,
    idempotentReplay: boolean,
    duplicateMessage: boolean,
  ): ProcessWagerTransactionResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.balanceAfter ?? null,
      idempotentReplay,
      failureCode: transaction.failureCode,
      duplicateMessage,
    };
  }
}

export const PROCESS_WAGER_TRANSACTION_USE_CASE = Symbol(
  'ProcessWagerTransactionUseCase',
);
