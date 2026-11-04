#!/bin/sh
# LocalStack ready hook: creates the FIFO queues used by the service.
# The app can also create them at boot (QUEUE_AUTO_CREATE), but creating them
# here keeps `docker compose up` deterministic and shows the DLQ wiring.
set -eu

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ENDPOINT="http://localhost:4566"

awslocal --region "$REGION" sqs create-queue \
  --endpoint-url "$ENDPOINT" \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,VisibilityTimeout=30 >/dev/null 2>&1 || true

DLQ_URL=$(awslocal --region "$REGION" sqs get-queue-url \
  --endpoint-url "$ENDPOINT" \
  --queue-name wager-transactions-dlq.fifo \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal --region "$REGION" sqs get-queue-attributes \
  --endpoint-url "$ENDPOINT" \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

awslocal --region "$REGION" sqs create-queue \
  --endpoint-url "$ENDPOINT" \
  --queue-name wager-transactions.fifo \
  --attributes "FifoQueue=true,VisibilityTimeout=30,RedrivePolicy={\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}" >/dev/null 2>&1 || true

# Outbound integration events live on their own queue: SQS has no fan-out, so
# mixing them with requests would make the request consumer read its own events.
awslocal --region "$REGION" sqs create-queue \
  --endpoint-url "$ENDPOINT" \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,VisibilityTimeout=30 >/dev/null 2>&1 || true

echo "SQS queues ready: wager-transactions.fifo, wager-transactions-dlq.fifo, wager-events.fifo"
