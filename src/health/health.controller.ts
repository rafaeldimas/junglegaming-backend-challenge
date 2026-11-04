import { Controller, Get, Res, Inject } from '@nestjs/common';
import type { Response } from 'express';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MIKRO_ORM } from '../config/tokens.js';
import { SqsClient } from '../messaging/sqs/sqs.client.js';
import { SqsQueues } from '../messaging/sqs/sqs-queues.js';
import { Public } from '../auth/auth.guard.js';
import { metrics } from '../platform/observability/metrics.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    private readonly sqsClient: SqsClient,
    private readonly queues: SqsQueues,
  ) {}

  @Get('health/live')
  @Public()
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @Public()
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgres, sqs] = await Promise.all([this.pingPostgres(), this.pingSqs()]);
    const ready = postgres && sqs;
    response.status(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not_ready',
      checks: {
        postgres: postgres ? 'up' : 'down',
        sqs: sqs ? 'up' : 'down',
      },
    };
  }

  @Get('metrics')
  @Public()
  async prometheus(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', metrics.registry.contentType);
    response.send(await metrics.registry.metrics());
  }

  private async pingPostgres(): Promise<boolean> {
    try {
      await this.orm.em.fork().getConnection().execute('select 1');
      return true;
    } catch {
      return false;
    }
  }

  private async pingSqs(): Promise<boolean> {
    try {
      return await this.sqsClient.isReachable(await this.queues.main());
    } catch {
      return false;
    }
  }
}
