import { IntegrationEvent } from './integration-event.js';
import { SerializedIntegrationEvent } from './integration-event.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: SerializedIntegrationEvent<unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

/**
 * Transactional outbox row. Created inside the same SQL transaction as the
 * financial change; published later by a worker using `FOR UPDATE SKIP LOCKED`.
 *
 * Idempotency: the outbox id is the integration event id, so replaying the same
 * event can never create two rows.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<SerializedIntegrationEvent<unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const serialized = event.toJSON();
    return new OutboxMessage(
      serialized.eventId,
      serialized.aggregateId,
      serialized.eventType,
      serialized,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt <= now)
    );
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Increments attempts and schedules the next attempt with capped exponential backoff. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(
      BASE_RETRY_MS * 2 ** (this._attempts - 1),
      MAX_RETRY_MS,
    );
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
