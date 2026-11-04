import { InboxMessage } from '../domain/inbox-message.js';
import { OutboxMessage } from '../domain/outbox-message.js';

export interface InboxRepository {
  /**
   * Inserts with `ON CONFLICT DO NOTHING`. Returns `true` when this consumer
   * won the race and owns the message, `false` when it was already received.
   */
  tryInsert(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}

export interface OutboxRepository {
  insertMany(messages: OutboxMessage[]): Promise<void>;
  /** Locks due rows with `FOR UPDATE SKIP LOCKED` inside the current transaction. */
  claimDue(limit: number, now: Date): Promise<OutboxMessage[]>;
  save(messages: OutboxMessage[]): Promise<void>;
  pendingStats(): Promise<{ pendingCount: number; oldestOccurredAt: Date | null }>;
}
