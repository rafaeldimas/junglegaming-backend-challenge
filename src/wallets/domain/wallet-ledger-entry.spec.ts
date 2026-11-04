import {
  InvalidMoneyError,
  InvalidWalletOperationError,
} from '../../shared/domain/errors.js';
import { Money } from '../../shared/domain/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

const AT = new Date('2026-01-01T00:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function entry(
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) {
  return WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('90.00'),
    createdAt: AT,
    ...overrides,
  });
}

describe('WalletLedgerEntry', () => {
  it('accepts a balanced debit and credit', () => {
    expect(entry().isBalanced()).toBe(true);
    expect(
      entry({
        direction: LedgerDirection.Credit,
        balanceBefore: brl('90.00'),
        balanceAfter: brl('100.00'),
      }).isBalanced(),
    ).toBe(true);
  });

  it('rejects an unbalanced entry', () => {
    expect(() => entry({ balanceAfter: brl('91.00') })).toThrow(
      InvalidWalletOperationError,
    );
  });

  it('rejects non-positive amounts and negative balances', () => {
    expect(() => entry({ money: brl('0.00') })).toThrow(InvalidMoneyError);
    expect(() =>
      entry({
        balanceBefore: brl('0.00'),
        balanceAfter: brl('10.00').negate(),
      }),
    ).toThrow(InvalidWalletOperationError);
  });

  it('rejects mixed currencies', () => {
    expect(() =>
      entry({ balanceAfter: Money.from({ amount: '90.00', currency: 'USD' }) }),
    ).toThrow(InvalidWalletOperationError);
  });

  it('rehydrates persisted state without revalidating arithmetic', () => {
    const rehydrated = WalletLedgerEntry.rehydrate({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: brl('10.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('80.00'),
      createdAt: AT,
    });

    expect(rehydrated.isBalanced()).toBe(false);
  });
});
