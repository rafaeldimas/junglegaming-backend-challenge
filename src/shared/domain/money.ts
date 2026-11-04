import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors.js';

export interface MoneyProps {
  /** Decimal string with fixed scale 2, e.g. "25.00". */
  amount: string;
  /** ISO-4217 currency code, e.g. "BRL". */
  currency: string;
}

const DecimalMoney = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  // Never let decimal.js switch to exponential notation.
  toExpNeg: -40,
  toExpPos: 40,
});

/** Non-negative decimal with at most two fraction digits, no exponent, no sign. */
const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable value object for monetary amounts.
 *
 * The internal representation is a `Decimal`; the public representation is a
 * fixed-scale (2) decimal string. `number`, `float` and `double` are never used
 * anywhere in the money path.
 *
 * Negative values may only appear as the result of arithmetic (`subtract`,
 * `negate`); `from()` rejects negative contract input. A negative `Money` is
 * never persisted: the wallet invariant rejects a negative balance first.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money must be an object with amount and currency');
    }

    const { amount, currency } = props;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Money amount must be a string');
    }
    if (typeof currency !== 'string') {
      throw new InvalidMoneyError('Money currency must be a string');
    }

    // Strict on purpose: whitespace is not part of the contract and would
    // otherwise make two visually identical payloads hash differently.
    const normalizedAmount = amount;
    if (normalizedAmount.length === 0) {
      throw new InvalidMoneyError('Money amount must not be empty');
    }
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency code: "${currency}"`);
    }
    if (!AMOUNT_PATTERN.test(normalizedAmount)) {
      throw new InvalidMoneyError(
        `Invalid money amount "${amount}": expected a non-negative decimal string with at most 2 fraction digits`,
      );
    }

    const value = new DecimalMoney(normalizedAmount);
    if (!value.isFinite()) {
      throw new InvalidMoneyError(`Invalid money amount "${amount}": must be finite`);
    }

    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency code: "${currency}"`);
    }
    return new Money(new DecimalMoney(0), currency);
  }

  /** Internal arithmetic constructor: allows negative values. */
  private static fromDecimal(value: Decimal, currency: string): Money {
    if (!value.isFinite()) {
      throw new InvalidMoneyError(`Invalid money result: ${value.toString()}`);
    }
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  /** Human readable form: `"25.00 BRL"`. Use `toJSON()` for contracts. */
  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
