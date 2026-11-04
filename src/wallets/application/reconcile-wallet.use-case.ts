import { UnitOfWork } from '../../platform/database/transaction-context.js';
import { WalletNotFoundError } from '../../platform/errors/application-error.js';
import { Money } from '../../shared/domain/money.js';
import { metrics } from '../../platform/observability/metrics.js';
import { logger } from '../../platform/logging/logger.js';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialised balance with the ledger sum. Divergences are never
 * corrected silently: they are logged, counted in a metric and returned.
 */
export class ReconcileWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    return this.uow.execute(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (wallet === null) {
        throw new WalletNotFoundError(walletId);
      }

      const aggregate = await ctx.ledger.aggregate(walletId, wallet.currency);
      const difference = wallet.balance.subtract(aggregate.balance);
      const consistent = difference.isZero();

      if (!consistent) {
        metrics.reconciliationMismatches.inc();
        logger.error(
          {
            walletId,
            storedBalance: wallet.balance.toJSON().amount,
            calculatedBalance: aggregate.balance.toJSON().amount,
            difference: difference.toJSON().amount,
            checkedEntries: aggregate.entryCount,
          },
          'wallet reconciliation mismatch',
        );
      }

      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance: aggregate.balance,
        difference,
        consistent,
        checkedEntries: aggregate.entryCount,
      };
    });
  }
}
