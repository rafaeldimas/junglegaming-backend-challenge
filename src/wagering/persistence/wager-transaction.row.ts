import { defineEntity, p } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../shared/domain/money.js';
import {
  WalletRow,
  WalletRowSchema,
} from '../../wallets/persistence/wallet.row.js';
import { FailureCode } from '../domain/failure-code.js';
import {
  TransactionOrigin,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';

export class WagerTransactionRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  origin!: TransactionOrigin;
  correlationId!: string;
  wallet!: WalletRow;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  status!: WagerTransactionStatus;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: FailureCode | null;
  balanceAfter?: string | null;
  walletVersionAfter?: number | null;
  pendingReferenceAttempts!: number;
  nextReferenceRetryAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
  updatedAt!: Date;
}

export const WagerTransactionRowSchema = defineEntity({
  class: WagerTransactionRow,
  className: 'WagerTransactionRow',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string().fieldName('provider_id'),
    externalTransactionId: p.string().fieldName('external_transaction_id'),
    idempotencyKey: p.string().fieldName('idempotency_key'),
    payloadHash: p.string().length(64).fieldName('payload_hash'),
    origin: p.enum([
      TransactionOrigin.Internal,
      TransactionOrigin.Api,
      TransactionOrigin.Sqs,
    ]),
    correlationId: p.string().fieldName('correlation_id'),
    wallet: p.manyToOne(WalletRowSchema).fieldName('wallet_id'),
    playerId: p.uuid().fieldName('player_id'),
    roundId: p.string().fieldName('round_id'),
    gameId: p.string().fieldName('game_id'),
    kind: p.enum([
      WagerTransactionKind.Opening,
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]),
    status: p.enum([
      WagerTransactionStatus.Pending,
      WagerTransactionStatus.PendingReference,
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ]),
    amount: p.decimal('string').columnType('numeric(20,2)'),
    currency: p.string().length(3),
    referenceExternalTransactionId: p
      .string()
      .nullable()
      .fieldName('reference_external_transaction_id'),
    referenceTransactionId: p
      .uuid()
      .nullable()
      .fieldName('reference_transaction_id'),
    failureCode: p
      .enum(Object.values(FailureCode))
      .nullable()
      .fieldName('failure_code'),
    balanceAfter: p
      .decimal('string')
      .columnType('numeric(20,2)')
      .nullable()
      .fieldName('balance_after'),
    walletVersionAfter: p
      .integer()
      .nullable()
      .fieldName('wallet_version_after'),
    pendingReferenceAttempts: p
      .integer()
      .fieldName('pending_reference_attempts'),
    nextReferenceRetryAt: p
      .datetime()
      .columnType('timestamptz(3)')
      .nullable()
      .fieldName('next_reference_retry_at'),
    createdAt: p
      .datetime()
      .columnType('timestamptz(3)')
      .fieldName('created_at'),
    processedAt: p
      .datetime()
      .columnType('timestamptz(3)')
      .nullable()
      .fieldName('processed_at'),
    updatedAt: p
      .datetime()
      .columnType('timestamptz(3)')
      .fieldName('updated_at'),
  },
  uniques: [
    { properties: ['providerId', 'externalTransactionId'] },
    { properties: ['providerId', 'idempotencyKey'] },
  ],
});

export function wagerTransactionToRow(
  transaction: WagerTransaction,
  em: EntityManager,
  row?: WagerTransactionRow,
): WagerTransactionRow {
  const target = row ?? new WagerTransactionRow();
  target.id = transaction.id;
  target.providerId = transaction.providerId;
  target.externalTransactionId = transaction.externalTransactionId;
  target.idempotencyKey = transaction.idempotencyKey;
  target.payloadHash = transaction.payloadHash;
  target.origin = transaction.origin;
  target.correlationId = transaction.correlationId;
  target.wallet = em.getReference(WalletRow, transaction.walletId);
  target.playerId = transaction.playerId;
  target.roundId = transaction.roundId;
  target.gameId = transaction.gameId;
  target.kind = transaction.kind;
  target.status = transaction.status;
  target.amount = transaction.money.toJSON().amount;
  target.currency = transaction.money.currency;
  target.referenceExternalTransactionId =
    transaction.referenceExternalTransactionId ?? null;
  target.referenceTransactionId = transaction.referenceTransactionId ?? null;
  target.failureCode = transaction.failureCode ?? null;
  target.balanceAfter = transaction.balanceAfter?.toJSON().amount ?? null;
  target.walletVersionAfter = transaction.walletVersionAfter ?? null;
  target.pendingReferenceAttempts = transaction.pendingReferenceAttempts;
  target.nextReferenceRetryAt = transaction.nextReferenceRetryAt ?? null;
  target.createdAt = transaction.createdAt;
  target.processedAt = transaction.processedAt ?? null;
  target.updatedAt = transaction.updatedAt;
  return target;
}

export function rowToWagerTransaction(
  row: WagerTransactionRow,
): WagerTransaction {
  const currency = row.currency;
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.wallet.id,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    money: Money.from({ amount: row.amount, currency }),
    referenceExternalTransactionId:
      row.referenceExternalTransactionId ?? undefined,
    origin: row.origin,
    correlationId: row.correlationId,
    status: row.status,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: row.failureCode ?? undefined,
    balanceAfter:
      row.balanceAfter === null || row.balanceAfter === undefined
        ? undefined
        : Money.from({ amount: row.balanceAfter, currency }),
    walletVersionAfter: row.walletVersionAfter ?? undefined,
    pendingReferenceAttempts: row.pendingReferenceAttempts,
    nextReferenceRetryAt: row.nextReferenceRetryAt ?? undefined,
    createdAt: row.createdAt,
    processedAt: row.processedAt ?? undefined,
    updatedAt: row.updatedAt,
  });
}
