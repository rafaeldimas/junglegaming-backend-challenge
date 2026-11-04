import { Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { AppEnv } from '../../config/env.js';
import { LedgerEntryRowSchema } from '../../wallets/persistence/ledger-entry.row.js';
import { WalletRowSchema } from '../../wallets/persistence/wallet.row.js';
import { WagerTransactionRowSchema } from '../../wagering/persistence/wager-transaction.row.js';
import { InboxRowSchema } from '../../messaging/persistence/inbox.row.js';
import { OutboxRowSchema } from '../../messaging/persistence/outbox.row.js';

export function createOrmConfig(env: AppEnv): Options {
  return {
    entities: [
      WalletRowSchema,
      LedgerEntryRowSchema,
      WagerTransactionRowSchema,
      InboxRowSchema,
      OutboxRowSchema,
    ],
    clientUrl: env.DATABASE_URL,
    extensions: [Migrator],
    migrations: {
      path: './src/migrations',
      pathTs: './src/migrations',
      transactional: true,
      allOrNothing: true,
    },
    allowGlobalContext: false,
    debug: false,
  };
}
