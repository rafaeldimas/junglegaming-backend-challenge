import { Injectable } from '@nestjs/common';
import { SerializedIntegrationEvent } from '../domain/integration-event.js';
import { SqsClient } from './sqs.client.js';
import { SqsQueues } from './sqs-queues.js';

export const EVENT_PUBLISHER = Symbol('EventPublisher');

export interface EventPublisher {
  publish(event: SerializedIntegrationEvent<unknown>): Promise<void>;
}

@Injectable()
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SqsClient,
    private readonly queues: SqsQueues,
  ) {}

  async publish(event: SerializedIntegrationEvent<unknown>): Promise<void> {
    await this.client.sendMessage({
      queueUrl: await this.queues.events(),
      body: JSON.stringify(event),
      groupId: event.aggregateId,
      deduplicationId: event.eventId,
      eventType: event.eventType,
      correlationId: event.correlationId,
    });
  }
}
