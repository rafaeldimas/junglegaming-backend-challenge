import { Injectable, OnApplicationBootstrap, OnApplicationShutdown, Inject } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import type { UnitOfWork } from '../../platform/database/transaction-context.js';
import type { Clock } from '../../shared/domain/clock.js';
import { CLOCK } from '../../shared/domain/clock.js';
import { metrics } from '../../platform/observability/metrics.js';
import { logger } from '../../platform/logging/logger.js';
import type { EventPublisher } from '../sqs/sqs-publisher.js';
import { EVENT_PUBLISHER } from '../sqs/sqs-publisher.js';
import { PeriodicWorker } from '../workers/periodic-worker.js';

/**
 * Publishes pending outbox rows. Multiple instances can run this worker: rows
 * are claimed with `FOR UPDATE SKIP LOCKED`, so each row is published by one
 * instance at a time. A crash after publish and before commit re-publishes the
 * event; consumers deduplicate, so duplicates are safe (at-least-once).
 */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly worker: PeriodicWorker;

  constructor(
    private readonly uow: UnitOfWork,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly env: AppEnv,
  ) {
    this.worker = new PeriodicWorker('outbox-publisher', env.OUTBOX_POLL_INTERVAL_MS, () => this.tick());
  }

  onApplicationBootstrap(): void {
    if (this.env.OUTBOX_PUBLISHER_ENABLED) {
      this.worker.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker.stop(this.env.SHUTDOWN_GRACE_MS);
  }

  /** Exposed for tests: runs one publish pass. */
  async tick(): Promise<void> {
    await this.uow.execute(async (ctx) => {
      const now = this.clock.now();
      const due = await ctx.outbox.claimDue(this.env.OUTBOX_BATCH_SIZE, now);
      if (due.length === 0) {
        return;
      }

      // Publish per aggregate group: events of the same aggregate keep their
      // order, while different aggregates are published concurrently. This is
      // what lets the publisher keep up with a burst of transactions.
      const groups = groupByAggregate(due);
      await runWithConcurrency(groups, this.env.OUTBOX_PUBLISH_CONCURRENCY, async (group) => {
        for (const message of group) {
          try {
            await this.publisher.publish(message.payload);
            message.markPublished(this.clock.now());
            metrics.outboxPublished.inc();
          } catch (error) {
            message.scheduleRetry(now);
            metrics.outboxPublishFailures.inc();
            logger.warn(
              { eventType: message.eventType, attempts: message.attempts, err: error },
              'outbox publish failed; retry scheduled',
            );
          }
        }
      });

      await ctx.outbox.save(due);
    });

    const stats = await this.uow.execute((ctx) => ctx.outbox.pendingStats());
    metrics.outboxPending.set(stats.pendingCount);
    metrics.outboxLag.set(
      stats.oldestOccurredAt === null
        ? 0
        : Math.max(0, (this.clock.now().getTime() - stats.oldestOccurredAt.getTime()) / 1000),
    );
  }
}

function groupByAggregate<T extends { aggregateId: string }>(messages: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const message of messages) {
    const group = groups.get(message.aggregateId);
    if (group === undefined) {
      groups.set(message.aggregateId, [message]);
    } else {
      group.push(message);
    }
  }
  return [...groups.values()];
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) {
        return;
      }
      await work(item);
    }
  });
  await Promise.all(workers);
}
