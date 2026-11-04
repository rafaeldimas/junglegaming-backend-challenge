import { defineEntity, p } from '@mikro-orm/postgresql';

export class InboxRow {
  id!: string;
  messageId!: string;
  consumerName!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxRowSchema = defineEntity({
  class: InboxRow,
  className: 'InboxRow',
  tableName: 'inbox_messages',
  properties: {
    id: p.uuid().primary(),
    messageId: p.string().fieldName('message_id'),
    consumerName: p.string().fieldName('consumer_name'),
    payloadHash: p.string().length(64).fieldName('payload_hash'),
    receivedAt: p
      .datetime()
      .columnType('timestamptz(3)')
      .fieldName('received_at'),
    processedAt: p
      .datetime()
      .columnType('timestamptz(3)')
      .nullable()
      .fieldName('processed_at'),
  },
  uniques: [{ properties: ['consumerName', 'messageId'] }],
});
