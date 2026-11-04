import { z } from 'zod';
import { InvalidPayloadError } from '../../platform/errors/application-error.js';
import { InvalidMoneyError } from '../../shared/domain/errors.js';
import { Money } from '../../shared/domain/money.js';
import { WagerTransactionKind } from '../domain/wager-transaction.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Matches the persisted column, so an oversized key is a 400, not a 500. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 191;

const moneySchema = z
  .object({
    amount: z.string(),
    currency: z.string(),
  })
  .strict();

const externalKindSchema = z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']);

const nonEmptyString = (max: number) => z.string().min(1).max(max);

const commandFieldsSchema = z
  .object({
    providerId: nonEmptyString(64),
    externalTransactionId: nonEmptyString(191),
    playerId: z.string().regex(UUID_PATTERN, 'playerId must be a UUID'),
    walletId: z.string().regex(UUID_PATTERN, 'walletId must be a UUID'),
    roundId: nonEmptyString(191),
    gameId: nonEmptyString(191),
    kind: externalKindSchema,
    money: moneySchema,
    referenceExternalTransactionId: nonEmptyString(191).optional(),
  })
  .strict();

const httpCommandSchema = commandFieldsSchema;

const queueEnvelopeSchema = z
  .object({
    messageId: nonEmptyString(191),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.string().datetime({ offset: true }),
    data: commandFieldsSchema.extend({
      idempotencyKey: nonEmptyString(191),
    }),
  })
  .strict();

export interface WagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface ParsedQueueMessage {
  messageId: string;
  command: WagerTransactionCommand;
}

const KIND_MAP: Record<
  z.infer<typeof externalKindSchema>,
  WagerTransactionKind
> = {
  BET: WagerTransactionKind.Bet,
  WIN: WagerTransactionKind.Win,
  LOSS: WagerTransactionKind.Loss,
  REFUND: WagerTransactionKind.Refund,
  ROLLBACK: WagerTransactionKind.Rollback,
};

export function parseHttpWagerCommand(
  body: unknown,
  idempotencyKey: string | undefined,
): WagerTransactionCommand {
  if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
    throw new InvalidPayloadError('The Idempotency-Key header is required');
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new InvalidPayloadError(
      `The Idempotency-Key header must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }
  const parsed = httpCommandSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidPayloadError(
      'Request payload is invalid',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return toCommand(parsed.data, idempotencyKey);
}

export function parseQueueEnvelope(raw: unknown): ParsedQueueMessage {
  const parsed = queueEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidPayloadError(
      'Queue message payload is invalid',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  const { idempotencyKey, ...fields } = parsed.data.data;
  return {
    messageId: parsed.data.messageId,
    command: toCommand(fields, idempotencyKey),
  };
}

function toCommand(
  fields: z.infer<typeof commandFieldsSchema>,
  idempotencyKey: string,
): WagerTransactionCommand {
  let money: Money;
  try {
    money = Money.from(fields.money);
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new InvalidPayloadError(error.message, [
        { path: 'money', message: error.message },
      ]);
    }
    throw error;
  }

  if (money.isZero() || money.isNegative()) {
    throw new InvalidPayloadError('money.amount must be strictly positive', [
      { path: 'money.amount', message: 'must be strictly positive' },
    ]);
  }

  return {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    idempotencyKey,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: KIND_MAP[fields.kind],
    money,
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
}
