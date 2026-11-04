import { EntityManager } from '@mikro-orm/postgresql';
import {
  InboxRepository,
  OutboxRepository,
} from '../../messaging/application/ports.js';
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from '../../messaging/persistence/repositories.js';
import {
  LedgerRepository,
  WalletRepository,
} from '../../wallets/application/ports.js';
import {
  MikroOrmLedgerRepository,
  MikroOrmWalletRepository,
} from '../../wallets/persistence/repositories.js';
import { WagerTransactionRepository } from '../../wagering/application/ports.js';
import { MikroOrmWagerTransactionRepository } from '../../wagering/persistence/repositories.js';

/** Repositories bound to one SQL transaction. */
export interface TransactionContext {
  readonly wallets: WalletRepository;
  readonly ledger: LedgerRepository;
  readonly wagerTransactions: WagerTransactionRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export function buildTransactionContext(em: EntityManager): TransactionContext {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    wagerTransactions: new MikroOrmWagerTransactionRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');

export interface UnitOfWork {
  execute<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}
