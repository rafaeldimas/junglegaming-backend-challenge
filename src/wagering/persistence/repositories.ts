import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { WagerTransactionRepository } from '../application/ports.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import {
  WagerTransactionRow,
  rowToWagerTransaction,
  wagerTransactionToRow,
} from './wager-transaction.row.js';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  /** Rows persisted in this transaction, so a second `update` never re-queries the DB. */
  private readonly rows = new Map<string, WagerTransactionRow>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, { id });
    return row === null ? null : rowToWagerTransaction(row);
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(
      WagerTransactionRow,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row === null ? null : rowToWagerTransaction(row);
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, {
      providerId,
      externalTransactionId,
    });
    return row === null ? null : rowToWagerTransaction(row);
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, {
      providerId,
      idempotencyKey,
    });
    return row === null ? null : rowToWagerTransaction(row);
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    const row = wagerTransactionToRow(transaction, this.em);
    this.rows.set(transaction.id, row);
    this.em.persist(row);
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const row =
      this.rows.get(transaction.id) ??
      (await this.em.findOne(WagerTransactionRow, { id: transaction.id }));
    if (row === null || row === undefined) {
      throw new Error(
        `Cannot update wager transaction ${transaction.id}: row not found`,
      );
    }
    this.rows.set(transaction.id, row);
    wagerTransactionToRow(transaction, this.em, row);
  }

  async findProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRow, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return row === null ? null : rowToWagerTransaction(row);
  }

  async findPendingReferences(
    limit: number,
    now: Date,
  ): Promise<WagerTransaction[]> {
    const rows = await this.em.find(
      WagerTransactionRow,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [
          { nextReferenceRetryAt: null },
          { nextReferenceRetryAt: { $lte: now } },
        ],
      },
      { orderBy: { createdAt: 'asc' }, limit },
    );
    return rows.map(rowToWagerTransaction);
  }

  async countPendingReferences(): Promise<number> {
    return this.em.count(WagerTransactionRow, {
      status: WagerTransactionStatus.PendingReference,
    });
  }
}
