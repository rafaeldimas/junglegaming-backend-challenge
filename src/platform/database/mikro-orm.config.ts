import { fileURLToPath } from 'node:url';
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
      // Resolves to `src/migrations` in development and `dist/migrations` once
      // compiled, so the same config works for the CLI and the container.
      path: fileURLToPath(new URL('../../migrations', import.meta.url)),
      pathTs: fileURLToPath(new URL('../../migrations', import.meta.url)),
      transactional: true,
      allOrNothing: true,
    },
    allowGlobalContext: false,
    debug: false,
  };
}
