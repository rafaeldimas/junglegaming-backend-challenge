import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Money } from '../../shared/domain/money.js';
import { CreateWalletUseCase } from '../application/create-wallet.use-case.js';
import { GetWalletLedgerUseCase, GetWalletUseCase } from '../application/wallet-queries.use-case.js';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case.js';
import { ZodValidationPipe } from '../../platform/http/zod-validation.pipe.js';
import { getLogContext } from '../../platform/logging/log-context.js';
import { decodeLedgerCursor } from '../application/cursor.js';
import { uuidSchema } from '../../platform/http/schemas.js';

/** The model is multi-currency; this delivery only accepts BRL at the edge. */
const createWalletSchema = z
  .object({
    playerId: uuidSchema,
    initialBalance: z
      .object({
        amount: z.string(),
        currency: z.literal('BRL'),
      })
      .strict(),
  })
  .strict();

const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

type CreateWalletBody = z.infer<typeof createWalletSchema>;
type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getLedger: GetWalletLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  async create(@Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletBody) {
    const wallet = await this.createWallet.execute(
      {
        playerId: body.playerId,
        initialBalance: Money.from(body.initialBalance),
      },
      getLogContext().correlationId ?? 'http',
    );

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  @Get(':walletId')
  async findOne(@Param('walletId', new ZodValidationPipe(uuidSchema)) walletId: string) {
    const wallet = await this.getWallet.execute(walletId);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ZodValidationPipe(uuidSchema)) walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
  ) {
    const cursor = query.cursor === undefined ? null : decodeLedgerCursor(query.cursor);
    const page = await this.getLedger.execute(walletId, cursor, query.limit);
    return {
      walletId,
      entries: page.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcileWallet(@Param('walletId', new ZodValidationPipe(uuidSchema)) walletId: string) {
    const result = await this.reconcile.execute(walletId);
    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}
