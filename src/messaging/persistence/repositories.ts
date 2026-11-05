import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { InboxRepository, OutboxRepository } from '../application/ports.js';
import { InboxMessage } from '../domain/inbox-message.js';
import { OutboxMessage } from '../domain/outbox-message.js';
import { rawQuery } from '../../platform/database/raw-query.js';
import { InboxRow, InboxRowSchema } from './inbox.row.js';
import {
  OutboxRow,
  OutboxRowSchema,
  outboxToRow,
  rowToOutboxMessage,
} from './outbox.row.js';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    const rows = await rawQuery<{ id: string }>(
      this.em,
      `insert into inbox_messages (id, message_id, consumer_name, payload_hash, received_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning id`,
      [
        message.id,
        message.messageId,
        message.consumerName,
        message.payloadHash,
        message.receivedAt,
      ],
    );
    return rows.length === 1;
  }

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const row = await this.em.findOne(InboxRow, { consumerName, messageId });
    if (row === null) {
      return null;
    }
    return InboxMessage.rehydrate({
      id: row.id,
      messageId: row.messageId,
      consumerName: row.consumerName,
      payloadHash: row.payloadHash,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt ?? undefined,
    });
  }

  async markProcessed(
    consumerName: string,
    messageId: string,
    at: Date,
  ): Promise<void> {
    await this.em.nativeUpdate(
      InboxRow,
      { consumerName, messageId },
      { processedAt: at },
    );
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertMany(messages: OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      this.em.persist(outboxToRow(message));
    }
  }

  async claimDue(limit: number, now: Date): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxRow,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return rows.map(rowToOutboxMessage);
  }

  async save(messages: OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      // `findOne` returns the managed row already claimed by `claimDue`, so
      // `outboxToRow` mutates a tracked entity. Flushing here makes the write
      // explicit and surfaces constraint errors at save time; the unit of work
      // would flush again (a no-op) before committing the transaction.
      const row = await this.em.findOne(OutboxRow, { id: message.id });
      if (row === null) {
        throw new Error(
          `Cannot update outbox message ${message.id}: row not found`,
        );
      }
      outboxToRow(message, row);
    }
    await this.em.flush();
  }

  async pendingStats(): Promise<{
    pendingCount: number;
    oldestOccurredAt: Date | null;
  }> {
    const rows = await this.em
      .getConnection()
      .execute<{ count: number | string; oldest: Date | null }[]>(
        `select count(*)::int as count, min(occurred_at) as oldest
         from outbox_messages
        where published_at is null`,
      );
    const row = rows[0];
    return {
      pendingCount: Number(row?.count ?? 0),
      oldestOccurredAt: row?.oldest == null ? null : new Date(row.oldest),
    };
  }
}

export const MESSAGING_ENTITY_SCHEMAS = [InboxRowSchema, OutboxRowSchema];
