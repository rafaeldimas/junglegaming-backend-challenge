/**
 * Application-level errors that are expected and map to stable HTTP responses.
 * Status numbers are kept here (instead of importing NestJS) so the application
 * layer stays framework-free.
 */
export class ApplicationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidPayloadError extends ApplicationError {
  constructor(message: string, details?: unknown) {
    super(message, 'INVALID_PAYLOAD', 400, details);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  constructor(message: string, details?: unknown) {
    super(message, 'IDEMPOTENCY_CONFLICT', 409, details);
  }
}

export class ExternalTransactionConflictError extends ApplicationError {
  constructor(message: string) {
    super(message, 'EXTERNAL_TRANSACTION_CONFLICT', 409);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor(message: string) {
    super(message, 'WALLET_ALREADY_EXISTS', 409);
  }
}

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`, 'WALLET_NOT_FOUND', 404, { walletId });
  }
}

export class TransactionNotFoundError extends ApplicationError {
  constructor(transactionId: string) {
    super(`Wager transaction ${transactionId} not found`, 'TRANSACTION_NOT_FOUND', 404, { transactionId });
  }
}

export class InfrastructureUnavailableError extends ApplicationError {
  constructor(message: string, details?: unknown) {
    super(message, 'INFRASTRUCTURE_UNAVAILABLE', 503, details);
  }
}

export class UnauthenticatedError extends ApplicationError {
  constructor(message = 'Missing or invalid credentials') {
    super(message, 'UNAUTHENTICATED', 401);
  }
}

export class ForbiddenError extends ApplicationError {
  constructor(message = 'Provider is not allowed to perform this operation') {
    super(message, 'FORBIDDEN', 403);
  }
}
