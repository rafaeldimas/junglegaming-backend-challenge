import { CurrencyMismatchError, InvalidMoneyError } from './errors.js';
import { Money } from './money.js';

describe('Money', () => {
  describe('from', () => {
    it('accepts a decimal string and serializes with fixed scale 2', () => {
      expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({
        amount: '25.00',
        currency: 'BRL',
      });
      expect(
        Money.from({ amount: '25.5', currency: 'BRL' }).toJSON().amount,
      ).toBe('25.50');
      expect(
        Money.from({ amount: '0.01', currency: 'BRL' }).toJSON().amount,
      ).toBe('0.01');
      expect(
        Money.from({ amount: '000123.4', currency: 'BRL' }).toJSON().amount,
      ).toBe('123.40');
    });

    it.each([
      ['', 'empty string'],
      ['   ', 'blank string'],
      ['1e3', 'scientific notation'],
      ['1.234', 'more than two decimals'],
      ['-1.00', 'negative input'],
      ['+1.00', 'explicit sign'],
      ['Infinity', 'Infinity'],
      ['NaN', 'NaN'],
      ['1,00', 'comma separator'],
      [
        ' 1.00',
        'surrounding space is trimmed but content must still be numeric',
      ],
    ])('rejects %s (%s)', (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it('rejects non-string amounts and unknown currencies', () => {
      expect(() =>
        Money.from({ amount: 10 as unknown as string, currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(
        InvalidMoneyError,
      );
      expect(() => Money.from({ amount: '1.00', currency: 'BRLX' })).toThrow(
        InvalidMoneyError,
      );
    });
  });

  it('is immutable: arithmetic returns a new instance', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = a.add(Money.from({ amount: '5.50', currency: 'BRL' }));

    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.50');
    expect(b).not.toBe(a);
  });

  it('adds, subtracts and negates exactly', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });

    expect(a.add(b).toJSON().amount).toBe('0.30');
    expect(b.subtract(a).toJSON().amount).toBe('0.10');
    expect(a.subtract(b).toJSON().amount).toBe('-0.10');
    expect(a.subtract(b).isNegative()).toBe(true);
    expect(b.subtract(a).negate().toJSON().amount).toBe('-0.10');
  });

  it('never drifts on repeated accumulation (no binary floating point)', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 100; i += 1) {
      total = total.add(Money.from({ amount: '0.01', currency: 'BRL' }));
    }
    expect(total.toJSON().amount).toBe('1.00');
  });

  it('compares amounts and rejects cross-currency operations', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(brl.equals(Money.from({ amount: '10.00', currency: 'BRL' }))).toBe(
      true,
    );
    expect(
      brl.isLessThan(Money.from({ amount: '10.01', currency: 'BRL' })),
    ).toBe(true);
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
  });

  it('exposes zero/positive/negative predicates', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
    expect(Money.from({ amount: '0.01', currency: 'BRL' }).isPositive()).toBe(
      true,
    );
    expect(
      Money.zero('BRL')
        .subtract(Money.from({ amount: '0.02', currency: 'BRL' }))
        .isNegative(),
    ).toBe(true);
  });
});
