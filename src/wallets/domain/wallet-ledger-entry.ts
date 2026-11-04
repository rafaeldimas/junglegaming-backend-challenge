import {
  InvalidMoneyError,
  InvalidWalletOperationError,
} from '../../shared/domain/errors.js';
import { Money } from '../../shared/domain/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {}

/**
 * Append-only record of a wallet balance movement.
 *
 * There are no mutators and no transitions: immutability is structural. The
 * database enforces the same rule with a trigger that rejects UPDATE/DELETE.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (props.id.length === 0) {
      throw new InvalidWalletOperationError(
        'Ledger entry id must not be empty',
      );
    }
    if (props.walletId.length === 0) {
      throw new InvalidWalletOperationError(
        'Ledger entry walletId must not be empty',
      );
    }
    if (props.transactionId.length === 0) {
      throw new InvalidWalletOperationError(
        'Ledger entry transactionId must not be empty',
      );
    }
    if (props.money.isNegative() || props.money.isZero()) {
      throw new InvalidMoneyError(
        'Ledger entry amount must be strictly positive',
      );
    }
    if (
      !(props.createdAt instanceof Date) ||
      Number.isNaN(props.createdAt.getTime())
    ) {
      throw new InvalidWalletOperationError(
        'Ledger entry createdAt must be a valid date',
      );
    }

    // Throws CurrencyMismatchError when any currency differs.
    const balances = [props.money, props.balanceBefore, props.balanceAfter];
    for (const money of balances) {
      if (money.currency !== balances[0]!.currency) {
        throw new InvalidWalletOperationError(
          'Ledger entry amounts must share the same currency',
        );
      }
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidWalletOperationError(
        'Ledger balances must never be negative',
      );
    }

    const expectedAfter =
      props.direction === LedgerDirection.Debit
        ? props.balanceBefore.subtract(props.money)
        : props.balanceBefore.add(props.money);

    if (!expectedAfter.equals(props.balanceAfter)) {
      throw new InvalidWalletOperationError(
        `Unbalanced ledger entry: ${props.balanceBefore.toString()} ${props.direction} ${props.money.toString()} != ${props.balanceAfter.toString()}`,
      );
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }

  /** Reconstruction from persistence: structural validation only, no transition rules. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** `balanceBefore ± money === balanceAfter`. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
