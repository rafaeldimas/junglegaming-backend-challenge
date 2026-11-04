import { defineEntity, p } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../shared/domain/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../domain/wallet-ledger-entry.js';
import {
  WagerTransactionRow,
  WagerTransactionRowSchema,
} from '../../wagering/persistence/wager-transaction.row.js';
import { WalletRow, WalletRowSchema } from './wallet.row.js';

/**
 * Rows are plain data holders; the domain object is the only place where
 * invariants live. `wallet` and `transaction` are mapped as relations (not
 * plain id columns) so MikroORM can derive the insert order from the foreign
 * keys: wallet -> wager transaction -> ledger entry.
 */
export class LedgerEntryRow {
  id!: string;
  wallet!: WalletRow;
  transaction!: WagerTransactionRow;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntryRowSchema = defineEntity({
  class: LedgerEntryRow,
  className: 'LedgerEntryRow',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    wallet: p.manyToOne(WalletRowSchema).fieldName('wallet_id'),
    transaction: p
      .manyToOne(WagerTransactionRowSchema)
      .fieldName('transaction_id'),
    direction: p.enum([LedgerDirection.Debit, LedgerDirection.Credit]),
    amount: p.decimal('string').columnType('numeric(20,2)'),
    currency: p.string().length(3),
    balanceBefore: p
      .decimal('string')
      .columnType('numeric(20,2)')
      .fieldName('balance_before'),
    balanceAfter: p
      .decimal('string')
      .columnType('numeric(20,2)')
      .fieldName('balance_after'),
    createdAt: p
      .datetime()
      .columnType('timestamptz(3)')
      .fieldName('created_at'),
  },
});

export function ledgerEntryToRow(
  entry: WalletLedgerEntry,
  em: EntityManager,
): LedgerEntryRow {
  const row = new LedgerEntryRow();
  row.id = entry.id;
  row.wallet = em.getReference(WalletRow, entry.walletId);
  row.transaction = em.getReference(WagerTransactionRow, entry.transactionId);
  row.direction = entry.direction;
  row.amount = entry.money.toJSON().amount;
  row.currency = entry.money.currency;
  row.balanceBefore = entry.balanceBefore.toJSON().amount;
  row.balanceAfter = entry.balanceAfter.toJSON().amount;
  row.createdAt = entry.createdAt;
  return row;
}

export function rowToLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  const currency = row.currency;
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet.id,
    transactionId: row.transaction.id,
    direction: row.direction,
    money: Money.from({ amount: row.amount, currency }),
    balanceBefore: Money.from({ amount: row.balanceBefore, currency }),
    balanceAfter: Money.from({ amount: row.balanceAfter, currency }),
    createdAt: row.createdAt,
  });
}
