import type { EntityManager } from '@mikro-orm/postgresql';

/**
 * Raw SQL that participates in the current transaction when the EntityManager
 * is transactional. Using `em.getConnection().execute()` without the context
 * would silently borrow another pooled connection and escape the transaction,
 * which breaks atomicity for writes (for example the inbox insert).
 */
export function rawQuery<T>(
  em: EntityManager,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return em
    .getConnection()
    .execute<T[]>(sql, params, 'all', em.getTransactionContext());
}
