import { UnitOfWork } from '../../platform/database/transaction-context.js';
import { TransactionNotFoundError } from '../../platform/errors/application-error.js';
import { WagerTransaction } from '../domain/wager-transaction.js';

export class GetWagerTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    return this.uow.execute(async (ctx) => {
      const transaction = await ctx.wagerTransactions.findById(transactionId);
      if (transaction === null) {
        throw new TransactionNotFoundError(transactionId);
      }
      return transaction;
    });
  }

  async byProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return this.uow.execute(async (ctx) => {
      const transaction = await ctx.wagerTransactions.findByProviderExternalId(
        providerId,
        externalTransactionId,
      );
      if (transaction === null) {
        throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
      }
      return transaction;
    });
  }
}
