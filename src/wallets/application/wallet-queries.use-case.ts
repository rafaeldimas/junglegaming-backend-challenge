import { UnitOfWork } from '../../platform/database/transaction-context.js';
import { WalletNotFoundError } from '../../platform/errors/application-error.js';
import { Money } from '../../shared/domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { LedgerCursor, LedgerPage } from './ports.js';
import { encodeLedgerCursor } from './cursor.js';

export class GetWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    return this.uow.execute(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (wallet === null) {
        throw new WalletNotFoundError(walletId);
      }
      return wallet;
    });
  }
}

export interface LedgerPageResult {
  entries: Array<{
    id: string;
    transactionId: string;
    direction: string;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
  }>;
  nextCursor: string | null;
}

export class GetWalletLedgerUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(
    walletId: string,
    cursor: LedgerCursor | null,
    limit: number,
  ): Promise<LedgerPageResult> {
    return this.uow.execute(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (wallet === null) {
        throw new WalletNotFoundError(walletId);
      }
      const page: LedgerPage = await ctx.ledger.page(walletId, cursor, limit);
      return {
        entries: page.entries.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money,
          balanceBefore: entry.balanceBefore,
          balanceAfter: entry.balanceAfter,
          createdAt: entry.createdAt,
        })),
        nextCursor:
          page.nextCursor === null ? null : encodeLedgerCursor(page.nextCursor),
      };
    });
  }
}
