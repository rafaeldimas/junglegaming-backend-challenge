import { Money } from '../../shared/domain/money.js';
import {
  canonicalWagerPayload,
  hashWagerPayload,
  stableStringify,
} from './canonical-payload.js';

const money = Money.from({ amount: '25', currency: 'BRL' });

function payload(
  overrides: Partial<Parameters<typeof canonicalWagerPayload>[0]> = {},
) {
  return canonicalWagerPayload({
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money,
    ...overrides,
  });
}

describe('canonical payload', () => {
  it('sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('produces the same bytes regardless of property insertion order', () => {
    const first = stableStringify({ a: 1, b: 2 });
    const second = stableStringify({ b: 2, a: 1 });
    expect(first).toBe(second);
  });

  it('normalizes money to scale 2', () => {
    expect(payload()).toContain('"money":{"amount":"25.00","currency":"BRL"}');
    expect(
      payload({ money: Money.from({ amount: '25.00', currency: 'BRL' }) }),
    ).toBe(payload());
  });

  it('treats an absent reference as null', () => {
    expect(payload()).toBe(payload({ referenceExternalTransactionId: null }));
    expect(payload()).toBe(
      payload({ referenceExternalTransactionId: undefined }),
    );
  });

  it('ignores transport data: only business fields are hashed', () => {
    const withReference = payload({
      referenceExternalTransactionId: 'external-0',
    });
    expect(withReference).not.toBe(payload());
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'external-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-2' }],
    ['gameId', { gameId: 'game-2' }],
    ['kind', { kind: 'WIN' }],
    ['money', { money: Money.from({ amount: '25.01', currency: 'BRL' }) }],
    ['reference', { referenceExternalTransactionId: 'external-0' }],
  ])('changes when %s changes', (_field, override) => {
    expect(payload(override)).not.toBe(payload());
  });

  it('hashes with SHA-256 hex and is stable', () => {
    const hash = hashWagerPayload(payload());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashWagerPayload(payload()));
    expect(hash).not.toBe(hashWagerPayload(payload({ kind: 'WIN' })));
  });
});
