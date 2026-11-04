import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from '../../shared/domain/errors.js';
import { Money } from '../../shared/domain/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openedAt: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  at: Date;
}

/**
 * Wallet aggregate root.
 *
 * Every balance change produces exactly one ledger entry, carried out by the
 * same method that changes the balance, so the two can never drift inside
 * memory. Persistence commits both in one SQL transaction.
 *
 * `version` starts at 1 and increments only when the balance changes. It is
 * exported for clients/tests and used as an optimistic concurrency token by
 * consumers of the API; the write path itself relies on pessimistic row locks
 * (`SELECT ... FOR UPDATE`), which are justified in ARCHITECTURE.md.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.id.length === 0) {
      throw new InvalidWalletOperationError('Wallet id must not be empty');
    }
    if (props.playerId.length === 0) {
      throw new InvalidWalletOperationError(
        'Wallet playerId must not be empty',
      );
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError(
        'Wallet initial balance must not be negative',
      );
    }
    if (
      !(props.openedAt instanceof Date) ||
      Number.isNaN(props.openedAt.getTime())
    ) {
      throw new InvalidWalletOperationError(
        'Wallet openedAt must be a valid date',
      );
    }

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.openedAt,
      props.openedAt,
    );
  }

  /** Reconstruction from persistence: does not revalidate transitions or invariants. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Debits `money` and returns the matching ledger entry.
   * Throws `InsufficientFundsError` when the balance would go negative.
   */
  debit(money: Money, movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(money, movement);

    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(
        this.id,
        this._balance.toJSON().amount,
        money.toJSON().amount,
        this.currency,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(money);

    return this.applyMovement(
      LedgerDirection.Debit,
      money,
      balanceBefore,
      balanceAfter,
      movement,
    );
  }

  /** Credits `money` and returns the matching ledger entry. */
  credit(money: Money, movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(money, movement);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(money);

    return this.applyMovement(
      LedgerDirection.Credit,
      money,
      balanceBefore,
      balanceAfter,
      movement,
    );
  }

  private applyMovement(
    direction: LedgerDirection,
    money: Money,
    balanceBefore: Money,
    balanceAfter: Money,
    movement: WalletMovement,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;

    return entry;
  }

  private assertMovement(money: Money, movement: WalletMovement): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
    if (money.isNegative() || money.isZero()) {
      throw new InvalidWalletOperationError(
        'Wallet movement amount must be strictly positive',
      );
    }
    if (movement.entryId.length === 0 || movement.transactionId.length === 0) {
      throw new InvalidWalletOperationError(
        'Wallet movement ids must not be empty',
      );
    }
    if (!(movement.at instanceof Date) || Number.isNaN(movement.at.getTime())) {
      throw new InvalidWalletOperationError(
        'Wallet movement date must be valid',
      );
    }
  }
}
