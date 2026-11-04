import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Message } from '@aws-sdk/client-sqs';
import type { AppEnv } from '../../config/env.js';
import type { Clock } from '../../shared/domain/clock.js';
import { CLOCK } from '../../shared/domain/clock.js';
import { DomainError } from '../../shared/domain/errors.js';
import { metrics } from '../../platform/observability/metrics.js';
import { logger } from '../../platform/logging/logger.js';
import { enrichLogContext, runWithLogContext } from '../../platform/logging/log-context.js';
import {
  ApplicationError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
} from '../../platform/errors/application-error.js';
import { TransactionOrigin } from '../../wagering/domain/wager-transaction.js';
import {
  PROCESS_WAGER_TRANSACTION_USE_CASE,
  ProcessWagerTransactionUseCase,
} from '../../wagering/application/process-wager-transaction.use-case.js';
import { parseQueueEnvelope } from '../../wagering/application/wager-command.js';
import { SqsClient } from './sqs.client.js';
import { SqsQueues } from './sqs-queues.js';

export const WAGER_CONSUMER_NAME = 'sqs:wager-transactions';

/**
 * SQS FIFO consumer.
 *
 * - reuses `ProcessWagerTransactionUseCase` (same code path as HTTP);
 * - deduplicates through the persistent inbox `(consumer_name, message_id)`;
 * - deletes (acks) only after the SQL transaction committed;
 * - business rejections are returned by the use case and therefore acked;
 * - invalid payloads, idempotency conflicts and exhausted retries go to the DLQ;
 * - transient failures leave the message for redelivery (visibility timeout).
 */
@Injectable()
export class SqsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private running = false;
  private loopPromise?: Promise<void>;
  private abortController?: AbortController;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly client: SqsClient,
    private readonly queues: SqsQueues,
    @Inject(PROCESS_WAGER_TRANSACTION_USE_CASE)
    private readonly useCase: ProcessWagerTransactionUseCase,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly env: AppEnv,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.SQS_CONSUMER_ENABLED) {
      return;
    }
    await this.queues.ensureReady();
    this.running = true;
    this.loopPromise = this.loop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    const grace = this.env.SHUTDOWN_GRACE_MS;
    await Promise.race([
      Promise.allSettled(this.inFlight),
      new Promise<void>((resolve) => setTimeout(resolve, grace)),
    ]);
    if (this.loopPromise !== undefined) {
      await Promise.race([this.loopPromise, new Promise<void>((resolve) => setTimeout(resolve, grace))]);
    }
  }

  private async loop(): Promise<void> {
    const queueUrl = await this.queues.main();

    while (this.running) {
      this.abortController = new AbortController();
      try {
        const messages = await this.client.receiveMessages({
          queueUrl,
          maxMessages: 10,
          waitTimeSeconds: this.env.SQS_WAIT_TIME_SECONDS,
          visibilityTimeoutSeconds: this.env.SQS_VISIBILITY_TIMEOUT_SECONDS,
          signal: this.abortController.signal,
        });

        const tasks = messages.map((message) => this.track(this.handle(message)));
        await Promise.allSettled(tasks);
      } catch (error) {
        if (!this.running) {
          break;
        }
        logger.error({ err: error }, 'sqs receive failed; backing off');
        await sleep(1_000);
      }
    }
  }

  private track(task: Promise<void>): Promise<void> {
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
    return task;
  }

  private async handle(message: Message): Promise<void> {
    let parsed: ReturnType<typeof parseQueueEnvelope>;
    try {
      parsed = parseQueueEnvelope(JSON.parse(message.Body ?? ''));
    } catch (error) {
      logger.warn({ err: error, sqsMessageId: message.MessageId }, 'invalid queue payload; moving to DLQ');
      await this.moveToDlq(message, 'INVALID_PAYLOAD');
      return;
    }

    const correlationId =
      message.MessageAttributes?.correlationId?.StringValue ?? parsed.messageId ?? message.MessageId ?? 'unknown';

    await runWithLogContext(
      {
        correlationId,
        messageId: parsed.messageId,
        providerId: parsed.command.providerId,
        walletId: parsed.command.walletId,
      },
      async () => {
        try {
          const result = await this.useCase.execute(parsed.command, {
            origin: TransactionOrigin.Sqs,
            correlationId,
            inbox: {
              consumerName: WAGER_CONSUMER_NAME,
              messageId: parsed.messageId,
              receivedAt: this.clock.now(),
            },
          });
          enrichLogContext({ transactionId: result.transactionId ?? undefined });
          await this.ack(message);
          logger.info(
            {
              status: result.status,
              kind: parsed.command.kind,
              duplicateMessage: result.duplicateMessage ?? false,
              failureCode: result.failureCode,
            },
            'sqs message handled',
          );
        } catch (error) {
          if (isPermanent(error)) {
            logger.warn(
              { err: error, code: (error as ApplicationError).code },
              'permanent failure; moving message to DLQ',
            );
            await this.moveToDlq(message, (error as ApplicationError).code);
            return;
          }

          const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
          if (receiveCount >= this.env.SQS_MAX_ATTEMPTS) {
            logger.error({ err: error, receiveCount }, 'max attempts reached; moving message to DLQ');
            await this.moveToDlq(message, 'MAX_ATTEMPTS_EXCEEDED');
            return;
          }

          metrics.sqsRetries.inc();
          logger.warn(
            { err: error, receiveCount },
            'transient failure; message will be redelivered after the visibility timeout',
          );
        }
      },
    );
  }

  private async ack(message: Message): Promise<void> {
    if (message.ReceiptHandle === undefined) {
      return;
    }
    await this.client.deleteMessage(await this.queues.main(), message.ReceiptHandle);
  }

  private async moveToDlq(message: Message, reason: string): Promise<void> {
    const body = message.Body ?? '';
    const parsed = safeJson(body) as
      | { aggregateId?: string; correlationId?: string; data?: { walletId?: string } }
      | null;
    const groupId = parsed?.aggregateId ?? parsed?.data?.walletId ?? message.MessageId ?? 'unknown';
    const correlationId = parsed?.correlationId ?? message.MessageId ?? 'unknown';

    await this.client.sendMessage({
      queueUrl: await this.queues.dlq(),
      body,
      groupId,
      deduplicationId: `dlq:${message.MessageId ?? correlationId}`,
      eventType: 'DeadLettered',
      correlationId,
    });
    metrics.dlqMessages.inc();
    logger.warn({ reason, messageId: message.MessageId }, 'message moved to DLQ');
    await this.ack(message);
  }
}

function isPermanent(error: unknown): boolean {
  return (
    error instanceof InvalidPayloadError ||
    error instanceof IdempotencyConflictError ||
    error instanceof ExternalTransactionConflictError ||
    error instanceof WalletNotFoundError ||
    error instanceof DomainError
  );
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
