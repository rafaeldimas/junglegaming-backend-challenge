import { Injectable } from '@nestjs/common';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppEnv } from '../../config/env.js';

@Injectable()
export class SqsClient {
  private readonly client: SQSClient;

  constructor(env: AppEnv) {
    this.client = new SQSClient({
      endpoint: env.SQS_ENDPOINT,
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  async getQueueUrl(name: string): Promise<string | null> {
    try {
      const result = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
      return result.QueueUrl ?? null;
    } catch (error) {
      if (isQueueNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async createFifoQueue(name: string, attributes: Record<string, string>): Promise<string> {
    const result = await this.client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          ...attributes,
        },
      }),
    );
    if (result.QueueUrl === undefined) {
      throw new Error(`SQS did not return a URL for queue ${name}`);
    }
    return result.QueueUrl;
  }

  async getQueueArn(queueUrl: string): Promise<string> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
    const arn = result.Attributes?.QueueArn;
    if (arn === undefined) {
      throw new Error(`SQS did not return an ARN for ${queueUrl}`);
    }
    return arn;
  }

  async sendMessage(input: {
    queueUrl: string;
    body: string;
    groupId: string;
    deduplicationId: string;
    eventType: string;
    correlationId: string;
  }): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: input.queueUrl,
        MessageBody: input.body,
        MessageGroupId: input.groupId,
        MessageDeduplicationId: input.deduplicationId,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: input.eventType },
          correlationId: { DataType: 'String', StringValue: input.correlationId },
        },
      }),
    );
  }

  async receiveMessages(input: {
    queueUrl: string;
    maxMessages: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    signal?: AbortSignal;
  }) {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: input.queueUrl,
        MaxNumberOfMessages: input.maxMessages,
        WaitTimeSeconds: input.waitTimeSeconds,
        VisibilityTimeout: input.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: input.signal },
    );
    return result.Messages ?? [];
  }

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  async isReachable(queueUrl: string): Promise<boolean> {
    try {
      await this.client.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
      );
      return true;
    } catch {
      return false;
    }
  }
}

function isQueueNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === 'QueueDoesNotExist' ||
    candidate.Code === 'AWS.SimpleQueueService.NonExistentQueue' ||
    candidate.$metadata?.httpStatusCode === 400
  );
}
