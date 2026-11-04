import type { ArgumentsHost } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './exception.filter.js';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../errors/application-error.js';

function hostWith(response: {
  status: (code: number) => unknown;
  json: (body: unknown) => void;
}) {
  return {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

function capture() {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: unknown) {
      response.body = body;
    },
  };
  return response;
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps application errors to their status and code', () => {
    const response = capture();
    filter.catch(new WalletNotFoundError('wallet-1'), hostWith(response));

    expect(response.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(response.body).toMatchObject({
      error: { code: 'WALLET_NOT_FOUND' },
    });
  });

  it('maps conflicts to 409', () => {
    const response = capture();
    filter.catch(
      new IdempotencyConflictError('different payload'),
      hostWith(response),
    );

    expect(response.statusCode).toBe(HttpStatus.CONFLICT);
    expect(response.body).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('maps connection-level failures to 503 so providers retry', () => {
    const response = capture();
    filter.catch(
      { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
      hostWith(response),
    );

    expect(response.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(response.body).toMatchObject({
      error: { code: 'INFRASTRUCTURE_UNAVAILABLE' },
    });
  });

  it('maps unexpected errors to 500 without leaking details', () => {
    const response = capture();
    filter.catch(new Error('secret internals'), hostWith(response));

    expect(response.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected internal error' },
    });
  });
});
