import { defineEntity, p } from '@mikro-orm/postgresql';
import { Money } from '../../shared/domain/money.js';
import { Wallet } from '../domain/wallet.js';

export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  /** numeric(20,2) mapped as a decimal string, never as a JS number. */
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletRowSchema = defineEntity({
  class: WalletRow,
  className: 'WalletRow',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid().fieldName('player_id'),
    currency: p.string().length(3),
    balance: p.decimal('string').columnType('numeric(20,2)'),
    version: p.integer(),
    createdAt: p
      .datetime()
      .columnType('timestamptz(3)')
      .fieldName('created_at'),
    updatedAt: p
      .datetime()
      .columnType('timestamptz(3)')
      .fieldName('updated_at'),
  },
  uniques: [{ properties: ['playerId', 'currency'] }],
});

export function walletToRow(wallet: Wallet, row?: WalletRow): WalletRow {
  const target = row ?? new WalletRow();
  target.id = wallet.id;
  target.playerId = wallet.playerId;
  target.currency = wallet.currency;
  target.balance = wallet.balance.toJSON().amount;
  target.version = wallet.version;
  target.createdAt = wallet.createdAt;
  target.updatedAt = wallet.updatedAt;
  return target;
}

export function rowToWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
