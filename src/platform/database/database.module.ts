import {
  DynamicModule,
  Global,
  Inject,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../../config/env.js';
import { APP_ENV, MIKRO_ORM } from '../../config/tokens.js';
import { createOrmConfig } from './mikro-orm.config.js';
import { MikroOrmUnitOfWork } from './unit-of-work.js';
import { UNIT_OF_WORK } from './transaction-context.js';

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  static forRoot(): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: APP_ENV,
          useFactory: () => loadEnv(),
        },
        {
          provide: MIKRO_ORM,
          inject: [APP_ENV],
          useFactory: async (env: ReturnType<typeof loadEnv>) =>
            MikroORM.init(createOrmConfig(env)),
        },
        {
          provide: UNIT_OF_WORK,
          inject: [MIKRO_ORM],
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
        },
      ],
      exports: [APP_ENV, MIKRO_ORM, UNIT_OF_WORK],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
