import { MikroORM } from '@mikro-orm/postgresql';
import { UnitOfWork, buildTransactionContext } from './transaction-context.js';
import { metrics } from '../observability/metrics.js';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 25;

/** SQLSTATEs worth retrying as a whole transaction. */
const RETRYABLE_SQL_STATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
]);
const LOCK_CONFLICT_SQL_STATES = new Set(['40P01', '55P03']);

/** Connection-level failures: the request may succeed if retried later. */
const TRANSIENT_CONNECTION_SQL_STATES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);
const TRANSIENT_NODE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async execute<T>(
    work: (ctx: ReturnType<typeof buildTransactionContext>) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const em = this.orm.em.fork();
      try {
        return await em.transactional(async (transactionalEm) =>
          work(buildTransactionContext(transactionalEm)),
        );
      } catch (error) {
        lastError = error;
        const sqlState = findSqlState(error);
        if (sqlState !== undefined && LOCK_CONFLICT_SQL_STATES.has(sqlState)) {
          metrics.lockConflicts.inc();
        }
        if (
          sqlState === undefined ||
          !RETRYABLE_SQL_STATES.has(sqlState) ||
          attempt === MAX_ATTEMPTS
        ) {
          throw error;
        }
        await sleep(RETRY_BASE_DELAY_MS * attempt);
      }
    }

    throw lastError;
  }
}

export function findSqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current !== null && typeof current === 'object';
    depth += 1
  ) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (
      typeof candidate.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * True when the failure means "the dependency is unavailable right now", which
 * the HTTP layer maps to 503 so providers retry instead of fixing the payload.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  const sqlState = findSqlState(error);
  if (
    sqlState !== undefined &&
    (sqlState.startsWith('08') || TRANSIENT_CONNECTION_SQL_STATES.has(sqlState))
  ) {
    return true;
  }
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current !== null && typeof current === 'object';
    depth += 1
  ) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (
      typeof candidate.code === 'string' &&
      TRANSIENT_NODE_ERROR_CODES.has(candidate.code)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function isUniqueViolation(error: unknown): boolean {
  return findSqlState(error) === '23505';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
