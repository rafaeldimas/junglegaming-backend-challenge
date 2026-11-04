import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletOperationError } from '../../shared/domain/errors.js';
import { Money } from '../../shared/domain/money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';
import { Wallet, WalletMovement } from './wallet.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function movement(index: number): WalletMovement {
  return { entryId: `entry-${index}`, transactionId: `tx-${index}`, at: NOW };
}

function openWallet(initial = '100.00'): Wallet {
  return Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(initial), openedAt: NOW });
}

describe('Wallet', () => {
  it('opens with the initial balance, version 1 and the operation currency', () => {
    const wallet = openWallet();

    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toBe(NOW);
    expect(wallet.updatedAt).toBe(NOW);
  });

  it('rejects invalid opening props', () => {
    expect(() =>
      Wallet.open({ id: '', playerId: 'p', initialBalance: brl('1.00'), openedAt: NOW }),
    ).toThrow(InvalidWalletOperationError);
    expect(() =>
      Wallet.open({ id: 'w', playerId: '', initialBalance: brl('1.00'), openedAt: NOW }),
    ).toThrow(InvalidWalletOperationError);
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), openedAt: new Date('nope') }),
    ).toThrow(InvalidWalletOperationError);
  });

  it('debits, emits one balanced ledger entry and bumps the version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('25.00'), movement(1));

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('credits, emits one balanced ledger entry and bumps the version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(brl('10.50'), movement(1));

    expect(wallet.balance.toJSON().amount).toBe('110.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });

  it('never allows a negative balance', () => {
    const wallet = openWallet('10.00');

    expect(() => wallet.debit(brl('10.01'), movement(1))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  it('allows debiting the exact balance', () => {
    const wallet = openWallet('10.00');
    wallet.debit(brl('10.00'), movement(1));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  it('rejects movements in another currency', () => {
    const wallet = openWallet();
    expect(() => wallet.debit(Money.from({ amount: '1.00', currency: 'USD' }), movement(1))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('rejects zero, negative and malformed movements', () => {
    const wallet = openWallet();

    expect(() => wallet.credit(brl('0.00'), movement(1))).toThrow(InvalidWalletOperationError);
    expect(() => wallet.credit(brl('1.00').negate(), movement(1))).toThrow(InvalidWalletOperationError);
    expect(() => wallet.credit(brl('1.00'), { entryId: '', transactionId: 'tx', at: NOW })).toThrow(
      InvalidWalletOperationError,
    );
    expect(() => wallet.credit(brl('1.00'), { entryId: 'e', transactionId: '', at: NOW })).toThrow(
      InvalidWalletOperationError,
    );
    expect(() =>
      wallet.credit(brl('1.00'), { entryId: 'e', transactionId: 'tx', at: new Date('nope') }),
    ).toThrow(InvalidWalletOperationError);
  });

  it('keeps version and balance consistent over a sequence of movements', () => {
    const wallet = openWallet('100.00');
    const movements = [
      () => wallet.debit(brl('20.00'), movement(1)),
      () => wallet.credit(brl('5.00'), movement(2)),
      () => wallet.debit(brl('1.25'), movement(3)),
    ];

    const entries = movements.map((apply) => apply());

    expect(wallet.balance.toJSON().amount).toBe('83.75');
    expect(wallet.version).toBe(4);
    expect(entries.map((entry) => entry.direction)).toEqual([
      LedgerDirection.Debit,
      LedgerDirection.Credit,
      LedgerDirection.Debit,
    ]);
  });

  it('rehydrates without revalidating (persisted state is trusted)', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});
