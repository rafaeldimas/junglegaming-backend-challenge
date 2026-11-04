import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ProcessWagerTransactionUseCase,
  PROCESS_WAGER_TRANSACTION_USE_CASE,
} from '../application/process-wager-transaction.use-case.js';
import { Inject } from '@nestjs/common';
import { GetWagerTransactionUseCase } from '../application/wager-queries.use-case.js';
import { parseHttpWagerCommand } from '../application/wager-command.js';
import { TransactionOrigin, WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction.js';
import { getLogContext, enrichLogContext } from '../../platform/logging/log-context.js';
import { ZodValidationPipe } from '../../platform/http/zod-validation.pipe.js';
import { uuidSchema } from '../../platform/http/schemas.js';

@Controller()
export class WageringController {
  constructor(
    @Inject(PROCESS_WAGER_TRANSACTION_USE_CASE)
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly queries: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const command = parseHttpWagerCommand(body, idempotencyKey);
    enrichLogContext({ walletId: command.walletId, providerId: command.providerId });

    const result = await this.processTransaction.execute(command, {
      origin: TransactionOrigin.Api,
      correlationId: getLogContext().correlationId ?? 'http',
    });

    if (result.transactionId !== null) {
      enrichLogContext({ transactionId: result.transactionId });
    }

    // 202 pending | 422 business rejection | 201 processed | 200 idempotent replay
    const status =
      result.status === WagerTransactionStatus.PendingReference
        ? HttpStatus.ACCEPTED
        : result.status === WagerTransactionStatus.Rejected
          ? HttpStatus.UNPROCESSABLE_ENTITY
          : result.idempotentReplay
            ? HttpStatus.OK
            : HttpStatus.CREATED;
    response.status(status);

    const payload: Record<string, unknown> = {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance?.toJSON() ?? null,
      idempotentReplay: result.idempotentReplay,
    };
    if (result.failureCode !== undefined) {
      payload.failureCode = result.failureCode;
    }
    return payload;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId', new ZodValidationPipe(uuidSchema)) transactionId: string) {
    const transaction = await this.queries.byId(transactionId);
    return serializeTransaction(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const transaction = await this.queries.byProviderExternalId(providerId, externalTransactionId);
    return serializeTransaction(transaction);
  }
}

function serializeTransaction(transaction: WagerTransaction): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    createdAt: transaction.createdAt.toISOString(),
  };
  if (transaction.referenceExternalTransactionId !== undefined) {
    payload.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
  }
  if (transaction.referenceTransactionId !== undefined) {
    payload.referenceTransactionId = transaction.referenceTransactionId;
  }
  if (transaction.failureCode !== undefined) {
    payload.failureCode = transaction.failureCode;
  }
  if (transaction.balanceAfter !== undefined) {
    payload.balanceAfter = transaction.balanceAfter.toJSON();
  }
  if (transaction.walletVersionAfter !== undefined) {
    payload.walletVersionAfter = transaction.walletVersionAfter;
  }
  if (transaction.processedAt !== undefined) {
    payload.processedAt = transaction.processedAt.toISOString();
  }
  return payload;
}
