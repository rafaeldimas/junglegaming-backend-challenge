import { Money } from '../../shared/domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';

export interface FindWalletOptions {
  /** Issues `SELECT ... FOR UPDATE` for the wallet row. */
  forUpdate?: boolean;
}

export interface WalletRepository {
  findById(id: string, options?: FindWalletOptions): Promise<Wallet | null>;
  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
}

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: LedgerCursor | null;
}

export interface LedgerAggregate {
  balance: Money;
  entryCount: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
  page(
    walletId: string,
    cursor: LedgerCursor | null,
    limit: number,
  ): Promise<LedgerPage>;
  aggregate(walletId: string, currency: string): Promise<LedgerAggregate>;
}
