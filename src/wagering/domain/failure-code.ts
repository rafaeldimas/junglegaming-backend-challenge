/**
 * Stable, machine-readable failure taxonomy. Providers use it to decide
 * whether to resend, fix the payload or give up, so values are part of the
 * public contract and must never be renamed (add new ones instead).
 */
export enum FailureCode {
  /** BET (or any debit) larger than the available balance. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK that would take the wallet below zero — distinct from a normal bet rejection. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Wallet id does not exist. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** Wallet belongs to another player. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** REFUND/ROLLBACK arrived without referenceExternalTransactionId. */
  ReferenceRequired = 'REFERENCE_REQUIRED',
  /** Referenced transaction never showed up before the TTL was exhausted. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referenced transaction showed up after the TTL. Kept distinct for diagnostics. */
  ReferenceExpired = 'REFERENCE_EXPIRED',
  /** Referenced transaction exists but is not PROCESSED (still pending or already rejected). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** REFUND may only reference BET; ROLLBACK may reference BET, WIN or REFUND. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Reference belongs to a different player, wallet, currency or round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** REFUND/ROLLBACK amount differs from the referenced amount. */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** The reference was already reverted by the same operation type. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Kind not accepted from external ingress (OPENING) or unknown. */
  UnsupportedKind = 'UNSUPPORTED_KIND',
  /** Amount must be strictly positive and have at most two decimals. */
  InvalidAmount = 'INVALID_AMOUNT',
  /** Reference is malformed (points to itself, wrong provider, etc.). */
  InvalidReference = 'INVALID_REFERENCE',
  /** The referenced transaction was itself rejected/failed. */
  ReferenceNotSuccessful = 'REFERENCE_NOT_SUCCESSFUL',
  /** Permanent infrastructure failure after the transaction row was persisted. */
  InfraPermanentFailure = 'INFRA_PERMANENT_FAILURE',
}
