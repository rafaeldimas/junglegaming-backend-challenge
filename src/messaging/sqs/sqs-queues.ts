import { Injectable } from '@nestjs/common';
import type { AppEnv } from '../../config/env.js';
import { SqsClient } from './sqs.client.js';
import { logger } from '../../platform/logging/logger.js';

/**
 * Resolves (and, in development, creates) the FIFO main queue and its DLQ.
 * Idempotent: safe to call from every worker at boot.
 */
@Injectable()
export class SqsQueues {
  private mainUrl?: string;
  private dlqUrl?: string;
  private eventsUrl?: string;
  private ensurePromise?: Promise<void>;

  constructor(
    private readonly client: SqsClient,
    private readonly env: AppEnv,
  ) {}

  async ensureReady(): Promise<void> {
    if (this.mainUrl !== undefined && this.dlqUrl !== undefined && this.eventsUrl !== undefined) {
      return;
    }
    this.ensurePromise ??= this.ensure().finally(() => {
      this.ensurePromise = undefined;
    });
    await this.ensurePromise;
  }

  async main(): Promise<string> {
    await this.ensureReady();
    return this.mainUrl!;
  }

  async dlq(): Promise<string> {
    await this.ensureReady();
    return this.dlqUrl!;
  }

  /** Outbound integration events (written by the outbox publisher). */
  async events(): Promise<string> {
    await this.ensureReady();
    return this.eventsUrl!;
  }

  private async ensure(): Promise<void> {
    let dlqUrl = await this.client.getQueueUrl(this.env.SQS_DLQ_NAME);
    let mainUrl = await this.client.getQueueUrl(this.env.SQS_QUEUE_NAME);
    let eventsUrl = await this.client.getQueueUrl(this.env.SQS_EVENTS_QUEUE_NAME);

    if (mainUrl === null || dlqUrl === null || eventsUrl === null) {
      if (!this.env.QUEUE_AUTO_CREATE) {
        throw new Error(
          `SQS queues are missing (${this.env.SQS_QUEUE_NAME} / ${this.env.SQS_DLQ_NAME} / ${this.env.SQS_EVENTS_QUEUE_NAME}) and QUEUE_AUTO_CREATE is false`,
        );
      }

      dlqUrl ??= await this.client.createFifoQueue(this.env.SQS_DLQ_NAME, {
        VisibilityTimeout: String(this.env.SQS_VISIBILITY_TIMEOUT_SECONDS),
      });
      const dlqArn = await this.client.getQueueArn(dlqUrl);

      mainUrl ??= await this.client.createFifoQueue(this.env.SQS_QUEUE_NAME, {
        VisibilityTimeout: String(this.env.SQS_VISIBILITY_TIMEOUT_SECONDS),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(this.env.SQS_MAX_ATTEMPTS),
        }),
      });
      eventsUrl ??= await this.client.createFifoQueue(this.env.SQS_EVENTS_QUEUE_NAME, {
        VisibilityTimeout: String(this.env.SQS_VISIBILITY_TIMEOUT_SECONDS),
      });
      logger.info(
        {
          queue: this.env.SQS_QUEUE_NAME,
          dlq: this.env.SQS_DLQ_NAME,
          events: this.env.SQS_EVENTS_QUEUE_NAME,
        },
        'SQS queues ready',
      );
    }

    this.mainUrl = mainUrl;
    this.dlqUrl = dlqUrl;
    this.eventsUrl = eventsUrl;
  }
}
