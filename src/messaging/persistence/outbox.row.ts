import { defineEntity, p } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../domain/outbox-message.js';
import { SerializedIntegrationEvent } from '../domain/integration-event.js';

export class OutboxRow {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: SerializedIntegrationEvent<unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxRowSchema = defineEntity({
  class: OutboxRow,
  className: 'OutboxRow',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid().fieldName('aggregate_id'),
    eventType: p.string().fieldName('event_type'),
    payload: p.json<SerializedIntegrationEvent<unknown>>().columnType('jsonb'),
    occurredAt: p.datetime().columnType('timestamptz(3)').fieldName('occurred_at'),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz(3)').nullable().fieldName('next_attempt_at'),
    publishedAt: p.datetime().columnType('timestamptz(3)').nullable().fieldName('published_at'),
  },
});

export function outboxToRow(message: OutboxMessage, row?: OutboxRow): OutboxRow {
  const target = row ?? new OutboxRow();
  target.id = message.id;
  target.aggregateId = message.aggregateId;
  target.eventType = message.eventType;
  target.payload = message.payload;
  target.occurredAt = message.occurredAt;
  target.attempts = message.attempts;
  target.nextAttemptAt = message.nextAttemptAt ?? null;
  target.publishedAt = message.publishedAt ?? null;
  return target;
}

export function rowToOutboxMessage(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
  });
}
