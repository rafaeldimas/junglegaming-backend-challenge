import { InvalidMoneyError, InvalidTransactionStateError } from '../../shared/domain/errors.js';
import { Money } from '../../shared/domain/money.js';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry.js';
import { FailureCode } from './failure-code.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum TransactionOrigin {
  Internal = 'INTERNAL',
  Api = 'API',
  Sqs = 'SQS',
}

export const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  origin: TransactionOrigin;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  origin: TransactionOrigin;
  correlationId: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balanceAfter?: Money;
  walletVersionAfter?: number;
  pendingReferenceAttempts: number;
  nextReferenceRetryAt?: Date;
  createdAt: Date;
  processedAt?: Date;
  updatedAt: Date;
}

const REQUIRES_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const BALANCE_AFFECTING: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Opening,
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const ROLLBACKABLE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

/**
 * Wagering transaction aggregate.
 *
 * Valid transitions:
 *
 *   PENDING            -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE  -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PROCESSED | REJECTED | FAILED -> (terminal, no transition)
 *
 * Attempting to leave a terminal state is a programming error and throws.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Provider-side id — never the internal id. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly origin: TransactionOrigin,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _balanceAfter?: Money,
    private _walletVersionAfter?: number,
    private _pendingReferenceAttempts: number = 0,
    private _nextReferenceRetryAt?: Date,
    private _processedAt?: Date,
    private _updatedAt: Date = createdAt,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    return WagerTransaction.build(props, true);
  }

  /**
   * Ingestion rejection that still needs an auditable row (for example a
   * REFUND without a reference). Reference presence is not enforced because the
   * absence is exactly the reason for the rejection.
   */
  static createRejected(props: CreateWagerTransactionProps, code: FailureCode): WagerTransaction {
    const transaction = WagerTransaction.build(props, false);
    transaction._status = WagerTransactionStatus.Rejected;
    transaction._failureCode = code;
    return transaction;
  }

  private static build(props: CreateWagerTransactionProps, enforceReference: boolean): WagerTransaction {
    assertNonEmpty(props.id, 'id');
    assertNonEmpty(props.providerId, 'providerId');
    assertNonEmpty(props.externalTransactionId, 'externalTransactionId');
    assertNonEmpty(props.idempotencyKey, 'idempotencyKey');
    assertNonEmpty(props.payloadHash, 'payloadHash');
    assertNonEmpty(props.walletId, 'walletId');
    assertNonEmpty(props.playerId, 'playerId');
    assertNonEmpty(props.roundId, 'roundId');
    assertNonEmpty(props.gameId, 'gameId');
    assertNonEmpty(props.correlationId, 'correlationId');
    assertValidDate(props.createdAt, 'createdAt');

    if (props.kind === WagerTransactionKind.Opening && props.origin !== TransactionOrigin.Internal) {
      throw new InvalidTransactionStateError(props.id, 'NEW', 'submit an internal OPENING transaction externally');
    }
    if (props.kind !== WagerTransactionKind.Opening && props.origin === TransactionOrigin.Internal) {
      throw new InvalidTransactionStateError(props.id, 'NEW', 'create an external transaction as INTERNAL');
    }

    if (props.money.isNegative() || props.money.isZero()) {
      throw new InvalidMoneyError('Wager transaction amount must be strictly positive');
    }

    if (props.referenceExternalTransactionId !== undefined) {
      assertNonEmpty(props.referenceExternalTransactionId, 'referenceExternalTransactionId');
      if (props.referenceExternalTransactionId === props.externalTransactionId) {
        throw new InvalidTransactionStateError(props.id, 'NEW', 'reference itself');
      }
    }

    if (
      enforceReference &&
      REQUIRES_REFERENCE.has(props.kind) &&
      props.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidTransactionStateError(props.id, 'NEW', `create ${props.kind} without a reference`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.origin,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      props.createdAt,
    );
  }

  /** Reconstruction from persistence: only rebuilds already-persisted state. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.origin,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.balanceAfter,
      state.walletVersionAfter,
      state.pendingReferenceAttempts,
      state.nextReferenceRetryAt,
      state.processedAt,
      state.updatedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get walletVersionAfter(): number | undefined {
    return this._walletVersionAfter;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get pendingReferenceAttempts(): number {
    return this._pendingReferenceAttempts;
  }

  get nextReferenceRetryAt(): Date | undefined {
    return this._nextReferenceRetryAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter?: Money, walletVersionAfter?: number): void {
    this.assertNotTerminal('markProcessed');
    assertValidDate(at, 'processedAt');
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = at;
    this._updatedAt = at;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._walletVersionAfter = walletVersionAfter;
    this._nextReferenceRetryAt = undefined;
  }

  markPendingReference(at: Date = new Date()): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._updatedAt = at;
  }

  /** Registers the next retry attempt for an out-of-order reference. */
  scheduleReferenceRetry(nextAttemptAt: Date, at: Date): void {
    this.assertNotTerminal('scheduleReferenceRetry');
    this._status = WagerTransactionStatus.PendingReference;
    this._pendingReferenceAttempts += 1;
    this._nextReferenceRetryAt = nextAttemptAt;
    this._updatedAt = at;
  }

  reject(
    code: FailureCode,
    at: Date = new Date(),
    balanceAfter?: Money,
    walletVersionAfter?: number,
  ): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._walletVersionAfter = walletVersionAfter;
    this._nextReferenceRetryAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._updatedAt = at;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** LOSS records a result without moving money; terminal rejections never move money. */
  affectsBalance(): boolean {
    return BALANCE_AFFECTING.has(this.kind) && this._status !== WagerTransactionStatus.Rejected;
  }

  requiresReference(): boolean {
    return REQUIRES_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of the ledger entry for the operation, taking the referenced
   * transaction into account for ROLLBACK (always the inverse direction).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError(this.id, this._status, 'derive a ledger direction for LOSS');
      case WagerTransactionKind.Rollback:
        if (reference === undefined) {
          throw new InvalidTransactionStateError(this.id, this._status, 'derive a ROLLBACK direction without a reference');
        }
        switch (reference.kind) {
          case WagerTransactionKind.Bet:
            return LedgerDirection.Credit;
          case WagerTransactionKind.Win:
          case WagerTransactionKind.Refund:
            return LedgerDirection.Debit;
          default:
            throw new InvalidTransactionStateError(
              this.id,
              this._status,
              `rollback a ${reference.kind} transaction`,
            );
        }
    }
  }

  isRollbackable(): boolean {
    return ROLLBACKABLE.has(this.kind);
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, transition);
    }
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidTransactionStateError(field, 'NEW', `create a transaction with an empty ${field}`);
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidTransactionStateError(field, 'NEW', `create a transaction with an invalid ${field}`);
  }
}
