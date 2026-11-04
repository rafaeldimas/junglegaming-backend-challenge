import { InvalidPayloadError } from '../../platform/errors/application-error.js';
import { WagerTransactionKind } from '../domain/wager-transaction.js';
import { parseHttpWagerCommand, parseQueueEnvelope } from './wager-command.js';

const body = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('wager command parsing', () => {
  it('requires the idempotency key header', () => {
    expect(() => parseHttpWagerCommand(body, undefined)).toThrow(
      InvalidPayloadError,
    );
    expect(() => parseHttpWagerCommand(body, '   ')).toThrow(
      InvalidPayloadError,
    );
  });

  it('rejects an idempotency key longer than the persisted column', () => {
    expect(() => parseHttpWagerCommand(body, 'a'.repeat(192))).toThrow(
      InvalidPayloadError,
    );
    expect(
      parseHttpWagerCommand(body, 'a'.repeat(191)).idempotencyKey,
    ).toHaveLength(191);
  });

  it('maps the external kinds to the domain enum', () => {
    expect(parseHttpWagerCommand(body, 'key').kind).toBe(
      WagerTransactionKind.Bet,
    );
  });

  it('rejects OPENING from external ingress', () => {
    expect(() =>
      parseHttpWagerCommand({ ...body, kind: 'OPENING' }, 'key'),
    ).toThrow(InvalidPayloadError);
  });

  it('rejects non-positive and malformed money', () => {
    expect(() =>
      parseHttpWagerCommand(
        { ...body, money: { amount: '0.00', currency: 'BRL' } },
        'key',
      ),
    ).toThrow(InvalidPayloadError);
    expect(() =>
      parseHttpWagerCommand(
        { ...body, money: { amount: '1.234', currency: 'BRL' } },
        'key',
      ),
    ).toThrow(InvalidPayloadError);
  });

  it('rejects unknown fields and invalid identifiers', () => {
    expect(() =>
      parseHttpWagerCommand({ ...body, extra: true }, 'key'),
    ).toThrow(InvalidPayloadError);
    expect(() =>
      parseHttpWagerCommand({ ...body, walletId: 'not-a-uuid' }, 'key'),
    ).toThrow(InvalidPayloadError);
  });

  it('parses the SQS envelope and keeps the message id', () => {
    const parsed = parseQueueEnvelope({
      messageId: 'msg-123',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: { ...body, idempotencyKey: 'provider-a:transaction-123' },
    });

    expect(parsed.messageId).toBe('msg-123');
    expect(parsed.command.idempotencyKey).toBe('provider-a:transaction-123');
    expect(parsed.command.kind).toBe(WagerTransactionKind.Bet);
  });

  it('rejects an envelope with the wrong type or missing idempotency key', () => {
    expect(() =>
      parseQueueEnvelope({
        messageId: 'msg-123',
        type: 'SomethingElse',
        occurredAt: '2026-07-29T15:00:00.000Z',
        data: { ...body, idempotencyKey: 'key' },
      }),
    ).toThrow(InvalidPayloadError);
    expect(() =>
      parseQueueEnvelope({
        messageId: 'msg-123',
        type: 'WagerTransactionRequested',
        occurredAt: '2026-07-29T15:00:00.000Z',
        data: body,
      }),
    ).toThrow(InvalidPayloadError);
  });
});
