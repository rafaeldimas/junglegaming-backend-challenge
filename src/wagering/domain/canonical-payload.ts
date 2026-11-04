import { createHash } from 'node:crypto';
import { Money, MoneyProps } from '../../shared/domain/money.js';

export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

/**
 * Recursively sorts object keys so logically identical payloads always
 * serialize to the same bytes, regardless of property insertion order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Canonical form used for idempotency:
 * - only business fields (transport headers and metadata never participate);
 * - money normalized to scale 2;
 * - null and absent reference are equivalent;
 * - keys sorted recursively.
 */
export function canonicalWagerPayload(input: {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string | null;
}): string {
  const payload: WagerBusinessPayload = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money.toJSON(),
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
  };
  return stableStringify(payload);
}

/** SHA-256 (hex) of the canonical JSON. Algorithm documented in ARCHITECTURE.md. */
export function hashWagerPayload(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}
