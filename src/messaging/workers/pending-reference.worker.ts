import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import type { UnitOfWork } from '../../platform/database/transaction-context.js';
import type { Clock } from '../../shared/domain/clock.js';
import { CLOCK } from '../../shared/domain/clock.js';
import { metrics } from '../../platform/observability/metrics.js';
import { logger } from '../../platform/logging/logger.js';
import { WagerTransactionStatus } from '../../wagering/domain/wager-transaction.js';
import type { WagerTransactionApplier } from '../../wagering/application/wager-transaction-applier.js';
import { PeriodicWorker } from './periodic-worker.js';

/**
 * Reprocesses PENDING_REFERENCE transactions with exponential backoff
 * (5s, 15s, 45s, 2m, 5m) up to `PENDING_REFERENCE_MAX_ATTEMPTS`; a TTL of
 * `PENDING_REFERENCE_TTL_MINUTES` is the secondary stop condition.
 *
 * Each transaction is processed in its own SQL transaction and re-locked with
 * `FOR UPDATE`; concurrent workers skip rows already taken.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly worker: PeriodicWorker;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly applier: WagerTransactionApplier,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly env: AppEnv,
  ) {
    this.worker = new PeriodicWorker('pending-reference', env.PENDING_REFERENCE_POLL_INTERVAL_MS, () =>
      this.tick(),
    );
  }

  onApplicationBootstrap(): void {
    if (this.env.PENDING_REFERENCE_WORKER_ENABLED) {
      this.worker.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker.stop(this.env.SHUTDOWN_GRACE_MS);
  }

  /** Exposed for tests: runs one retry pass. */
  async tick(): Promise<void> {
    const now = this.clock.now();
    const pendingIds = await this.uow.execute(async (ctx) => {
      const pending = await ctx.wagerTransactions.findPendingReferences(
        this.env.PENDING_REFERENCE_BATCH_SIZE,
        now,
      );
      return pending.map((transaction) => transaction.id);
    });

    for (const transactionId of pendingIds) {
      try {
        await this.processOne(transactionId);
      } catch (error) {
        logger.error({ err: error, transactionId }, 'pending reference retry failed');
      }
    }

    const count = await this.uow.execute((ctx) => ctx.wagerTransactions.countPendingReferences());
    metrics.pendingReferenceTransactions.set(count);
  }

  private async processOne(transactionId: string): Promise<void> {
    await this.uow.execute(async (ctx) => {
      const transaction = await ctx.wagerTransactions.findByIdForUpdate(transactionId);
      if (transaction === null || transaction.status !== WagerTransactionStatus.PendingReference) {
        return;
      }

      await this.applier.apply(ctx, transaction, {
        correlationId: transaction.correlationId,
        referencePolicy: 'retry',
      });
    });
  }
}
