import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../config/env.js';
import { createOrmConfig } from '../platform/database/mikro-orm.config.js';

/**
 * CLI entry point: `bun run migration:up`, `bun run migration:down`,
 * `bun run migration:list`. Kept out of `src/migrations` so the migrator glob
 * only sees migration classes.
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const env = loadEnv();
  const orm = await MikroORM.init(createOrmConfig(env));

  try {
    switch (command) {
      case 'up':
        await orm.migrator.up();
        break;
      case 'down':
        await orm.migrator.down();
        break;
      case 'list':
        console.table(await orm.migrator.getPending());
        break;
      default:
        throw new Error(`Unknown migration command: ${command}`);
    }
  } finally {
    await orm.close(true);
  }
}

await main();
