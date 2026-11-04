import { InvalidPayloadError } from '../../platform/errors/application-error.js';
import { LedgerCursor } from './ports.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque, stable cursor: base64url of `{ t: ISO timestamp, id: UUIDv7 }`. */
export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), id: cursor.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeLedgerCursor(raw: string): LedgerCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidPayloadError('Invalid ledger cursor');
  }
  if (decoded === null || typeof decoded !== 'object') {
    throw new InvalidPayloadError('Invalid ledger cursor');
  }
  const candidate = decoded as { t?: unknown; id?: unknown };
  if (typeof candidate.t !== 'string' || typeof candidate.id !== 'string' || !UUID_PATTERN.test(candidate.id)) {
    throw new InvalidPayloadError('Invalid ledger cursor');
  }
  const createdAt = new Date(candidate.t);
  if (Number.isNaN(createdAt.getTime())) {
    throw new InvalidPayloadError('Invalid ledger cursor');
  }
  return { createdAt, id: candidate.id };
}
