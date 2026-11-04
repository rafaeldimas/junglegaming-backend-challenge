import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { Money } from '../../shared/domain/money.js';
import { LedgerCursor, LedgerPage, LedgerRepository, WalletRepository } from '../application/ports.js';
import { Wallet } from '../domain/wallet.js';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { LedgerEntryRow, ledgerEntryToRow, rowToLedgerEntry } from './ledger-entry.row.js';
import { WalletRow, rowToWallet, walletToRow } from './wallet.row.js';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string, options?: { forUpdate?: boolean }): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { id }, {
      lockMode: options?.forUpdate ? LockMode.PESSIMISTIC_WRITE : LockMode.NONE,
    });
    return row === null ? null : rowToWallet(row);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { playerId, currency });
    return row === null ? null : rowToWallet(row);
  }

  async insert(wallet: Wallet): Promise<void> {
    this.em.persist(walletToRow(wallet));
  }

  async update(wallet: Wallet): Promise<void> {
    const row = await this.em.findOne(WalletRow, { id: wallet.id });
    if (row === null) {
      throw new Error(`Cannot update wallet ${wallet.id}: row not found`);
    }
    walletToRow(wallet, row);
  }
}

interface LedgerRowJoin {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(ledgerEntryToRow(entry, this.em));
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null> {
    const row = await this.em.findOne(LedgerEntryRow, { transaction: transactionId });
    return row === null ? null : rowToLedgerEntry(row);
  }

  async page(walletId: string, cursor: LedgerCursor | null, limit: number): Promise<LedgerPage> {
    const params: unknown[] = [walletId];
    let cursorClause = '';
    if (cursor !== null) {
      params.push(cursor.createdAt, cursor.id);
      cursorClause = 'and (created_at, id) > (?::timestamptz, ?::uuid)';
    }
    params.push(limit + 1);

    const rows = await this.em.getConnection().execute<LedgerRowJoin[]>(
      `select id, wallet_id, transaction_id, direction, amount::text as amount, currency,
              balance_before::text as balance_before, balance_after::text as balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? ${cursorClause}
        order by created_at asc, id asc
        limit ?`,
      params,
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const entries = pageRows.map((row) =>
      WalletLedgerEntry.rehydrate({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: Money.from({ amount: row.amount, currency: row.currency }),
        balanceBefore: Money.from({ amount: row.balance_before, currency: row.currency }),
        balanceAfter: Money.from({ amount: row.balance_after, currency: row.currency }),
        createdAt: new Date(row.created_at),
      }),
    );

    const last = entries.at(-1);
    return {
      entries,
      nextCursor: hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async aggregate(walletId: string, currency: string) {
    const rows = await this.em.getConnection().execute<{ total: string; count: number | string }[]>(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as total,
              count(*)::int as count
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    const total = row?.total ?? '0';
    const count = Number(row?.count ?? 0);
    return {
      balance: Money.from({ amount: normaliseDecimal(total), currency }),
      entryCount: count,
    };
  }
}

/** Postgres numeric text may come as "0" or "10.50"; Money accepts both. */
function normaliseDecimal(value: string): string {
  return value.includes('.') ? value : `${value}.00`;
}
