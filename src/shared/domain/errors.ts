/**
 * Base class for expected domain failures. Domain errors are translated to
 * `failureCode`s (transaction level) or to HTTP 4xx responses (ingress level)
 * by the application layer. They never depend on NestJS or the ORM.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly walletId: string,
    readonly balance: string,
    readonly requested: string,
    readonly currency: string,
  ) {
    super(`Wallet ${walletId} has insufficient funds: balance ${balance} ${currency}, requested ${requested} ${currency}`);
  }
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = 'INVALID_WALLET_OPERATION';

  constructor(message: string) {
    super(message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(
    readonly transactionId: string,
    readonly currentStatus: string,
    readonly attemptedTransition: string,
  ) {
    super(`Transaction ${transactionId} is in terminal status ${currentStatus}; cannot ${attemptedTransition}`);
  }
}
