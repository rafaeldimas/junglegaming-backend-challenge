import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Single metrics registry for the process. Labels are deliberately low
 * cardinality: never providerId, walletId or transactionId.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wagering transactions by terminal status and kind',
    labelNames: ['status', 'kind'] as const,
    registers: [this.registry],
  });

  readonly processingLatency = new Histogram({
    name: 'wager_transaction_processing_seconds',
    help: 'Time spent processing a wagering transaction',
    labelNames: ['kind'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly idempotentReplays = new Counter({
    name: 'idempotent_replays_total',
    help: 'Requests that replayed the original result of an idempotency key',
    registers: [this.registry],
  });

  readonly idempotencyConflicts = new Counter({
    name: 'idempotency_conflicts_total',
    help: 'Same idempotency key with a different payload',
    registers: [this.registry],
  });

  readonly inboxDuplicates = new Counter({
    name: 'inbox_duplicates_total',
    help: 'SQS redeliveries short-circuited by the persistent inbox',
    registers: [this.registry],
  });

  readonly sqsRetries = new Counter({
    name: 'sqs_retries_total',
    help: 'SQS messages returned to the queue for a later attempt',
    registers: [this.registry],
  });

  readonly dlqMessages = new Counter({
    name: 'dlq_messages_total',
    help: 'Messages moved to the dead-letter queue',
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Transactions retried because of a lock conflict or deadlock',
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox messages successfully published',
    registers: [this.registry],
  });

  readonly outboxPublishFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox publish attempts that failed and were rescheduled',
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });

  readonly pendingReferenceTransactions = new Gauge({
    name: 'pending_reference_transactions',
    help: 'Transactions waiting for a referenced transaction',
    registers: [this.registry],
  });

  readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatch_total',
    help: 'Wallets whose stored balance diverged from the ledger',
    registers: [this.registry],
  });

  readonly walletCreated = new Counter({
    name: 'wallets_created_total',
    help: 'Wallets created',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  recordTransaction(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }
}

export const metrics = new Metrics();
