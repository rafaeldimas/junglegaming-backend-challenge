import { Money } from '../../shared/domain/money.js';
import type { Clock } from '../../shared/domain/clock.js';
import type { IdGenerator } from '../../shared/domain/id-generator.js';
import { TransactionContext, UnitOfWork } from '../../platform/database/transaction-context.js';
import { Wallet } from '../domain/wallet.js';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  TransactionOrigin,
} from '../../wagering/domain/wager-transaction.js';
import { canonicalWagerPayload, hashWagerPayload } from '../../wagering/domain/canonical-payload.js';
import { OutboxMessage } from '../../messaging/domain/outbox-message.js';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../messaging/domain/events.js';
import { EventContext } from '../../messaging/domain/integration-event.js';
import { WalletAlreadyExistsError } from '../../platform/errors/application-error.js';
import { isUniqueViolation } from '../../platform/database/unit-of-work.js';
import { metrics } from '../../platform/observability/metrics.js';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

/**
 * Creates the wallet, its optional internal OPENING transaction, the matching
 * CREDIT ledger entry and the outbox events in a single SQL transaction.
 *
 * The opening balance is part of creation, so `version` stays 1 (it only
 * increments when an existing wallet's balance changes).
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand, correlationId: string): Promise<Wallet> {
    try {
      const wallet = await this.uow.execute((ctx) => this.run(ctx, command, correlationId));
      metrics.walletCreated.inc();
      return wallet;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WalletAlreadyExistsError(
          `A wallet already exists for player ${command.playerId} in ${command.initialBalance.currency}`,
        );
      }
      throw error;
    }
  }

  private async run(
    ctx: TransactionContext,
    command: CreateWalletCommand,
    correlationId: string,
  ): Promise<Wallet> {
    const now = this.clock.now();
    const existing = await ctx.wallets.findByPlayerAndCurrency(
      command.playerId,
      command.initialBalance.currency,
    );
    if (existing !== null) {
      throw new WalletAlreadyExistsError(
        `A wallet already exists for player ${command.playerId} in ${command.initialBalance.currency}`,
      );
    }

    const wallet = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openedAt: now,
    });

    await ctx.wallets.insert(wallet);

    if (command.initialBalance.isZero()) {
      return wallet;
    }

    const openingId = this.ids.next();
    const openingPayload = canonicalWagerPayload({
      providerId: 'internal',
      externalTransactionId: `opening:${wallet.id}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'opening',
      gameId: 'opening',
      kind: 'OPENING',
      money: command.initialBalance,
      referenceExternalTransactionId: null,
    });

    const opening = WagerTransaction.create({
      id: openingId,
      providerId: 'internal',
      externalTransactionId: `opening:${wallet.id}`,
      idempotencyKey: `opening:${wallet.id}`,
      payloadHash: hashWagerPayload(openingPayload),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: command.initialBalance,
      origin: TransactionOrigin.Internal,
      correlationId,
      createdAt: now,
    });
    opening.markProcessed(undefined, now, wallet.balance, wallet.version);

    const entry = WalletLedgerEntry.create({
      id: this.ids.next(),
      walletId: wallet.id,
      transactionId: opening.id,
      direction: LedgerDirection.Credit,
      money: command.initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: now,
    });

    await ctx.wagerTransactions.insert(opening);
    await ctx.ledger.insert(entry);

    const eventContext = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId,
      occurredAt: now,
    });
    await ctx.outbox.insertMany([
      OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, eventContext())),
      OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, eventContext())),
    ]);

    return wallet;
  }
}
