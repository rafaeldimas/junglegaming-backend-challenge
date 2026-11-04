# Distributed Wagering Processor

A NestJS service that processes wagering operations from multiple game
providers against player wallets, with exact money handling, persistent
idempotency, a per-wallet concurrency guarantee, a transactional outbox and
at-least-once SQS consumption.

Design decisions, trade-offs and diagrams: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

- Bun 1.x · TypeScript (strict) · NestJS 12
- PostgreSQL 16 + MikroORM 7 (versioned, reversible migrations)
- AWS SQS FIFO via LocalStack 3.8
- decimal.js for money · UUIDv7 ids
- pino JSON logs · prom-client metrics
- Vitest + Testcontainers for unit and integration tests

## Quick start (Docker Compose)

Requires Docker with Compose v2.

```bash
docker compose up --build
```

This starts PostgreSQL, LocalStack (queues and DLQ pre-created), runs the
migrations, then starts the API behind nginx.

- API: <http://localhost:8080>
- Health: <http://localhost:8080/health/ready>
- Metrics: <http://localhost:8080/metrics>
- LocalStack: <http://localhost:4566>

To run the multi-instance scenario:

```bash
docker compose up -d --build --scale app=3
```

The app container publishes no host port on purpose; nginx resolves `app` on
every request through Docker DNS, so requests are spread across the replicas.

Stop and remove volumes:

```bash
docker compose down -v
```

## Local development

```bash
bun install
cp .env.example .env
```

Start PostgreSQL and LocalStack (or use your own):

```bash
docker run -d --name jungle-pg \
  -e POSTGRES_USER=jungle -e POSTGRES_PASSWORD=jungle -e POSTGRES_DB=jungle \
  -p 5432:5432 postgres:16-alpine

docker run -d --name jungle-localstack \
  -e SERVICES=sqs -p 4566:4566 localstack/localstack:3.8
```

Apply the schema and start the app:

```bash
bun run migration:up
bun run start:dev
```

The service creates the FIFO queues at boot when they are missing
(`QUEUE_AUTO_CREATE=true`).

## Commands

| Command | Description |
|---|---|
| `bun run start:dev` | watch mode |
| `bun run start` | start once |
| `bun run build` | compile to `dist/` |
| `bun run start:prod` | run the compiled app with Bun |
| `bun run migration:up` | apply pending migrations |
| `bun run migration:down` | revert the last migration |
| `bun run migration:list` | list pending migrations |
| `bun run test` | unit tests |
| `bun run test:e2e` | integration/concurrency tests (Docker required) |
| `bun run test:all` | unit + e2e |
| `bun run lint` | oxlint (type-aware) |
| `bun run format` | prettier |

Configuration is validated at boot (see `.env.example`); invalid values fail
fast with a readable message.

## API

### Create a wallet

```bash
curl -X POST http://localhost:8080/wallets \
  -H 'content-type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "100.00", "currency": "BRL" }
  }'
```

The initial balance, when greater than zero, creates an internal `OPENING`
transaction and its ledger entry in the same SQL transaction. Creating a second
wallet for the same `playerId + currency` returns `409`.

### Submit a wager transaction

```bash
curl -X POST http://localhost:8080/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<wallet-id>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Repeating the request returns the original result with
`"idempotentReplay": true`. Reusing the key with a different payload returns
`409 IDEMPOTENCY_CONFLICT`.

### Queries

```bash
curl http://localhost:8080/wallets/<wallet-id>
curl 'http://localhost:8080/wallets/<wallet-id>/ledger?limit=50'
curl http://localhost:8080/wagering/transactions/<transaction-id>
curl http://localhost:8080/providers/provider-a/wagering/transactions/transaction-123
curl -X POST http://localhost:8080/wallets/<wallet-id>/reconciliation
```

The ledger cursor is opaque and stable (`created_at, id`); pass the returned
`nextCursor` to fetch the next page.

### Status codes

| Code | Meaning |
|---|---|
| `201` | processed |
| `200` | idempotent replay / successful query |
| `202` | accepted, waiting for a reference (`PENDING_REFERENCE`) |
| `400` | invalid payload |
| `404` | wallet or transaction not found |
| `409` | idempotency, external id or wallet conflict |
| `422` | business rejection (body has `failureCode`) |
| `503` | transient infrastructure failure |

Business rejections are persisted with a machine-readable `failureCode`; the
full table is in [`ARCHITECTURE.md`](./ARCHITECTURE.md#15-failure-taxonomy).

## SQS

The consumer reads `wager-transactions.fifo`; permanent failures go to
`wager-transactions-dlq.fifo`. Outbound integration events are published to
`wager-events.fifo`.

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Send a message with the AWS CLI against LocalStack:

```bash
aws --endpoint-url=http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <wallet-id> \
  --message-deduplication-id "msg-123" \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...}}'
```

Events published by the outbox: `WagerTransactionProcessed`,
`WagerTransactionRejected`, `WalletBalanceChanged` and
`WagerTransactionPendingReference`. Each envelope carries `eventId`,
`eventType`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt`,
`version` and `data`; consumers must deduplicate by `eventId`.

## Out-of-order references

`REFUND` and `ROLLBACK` sent before their reference are accepted (`202`) and
stored as `PENDING_REFERENCE`. A scheduled worker retries after 5s, 15s, 45s,
2m and 5m, up to 5 attempts or a 15-minute TTL, then rejects with
`REFERENCE_NOT_FOUND` / `REFERENCE_EXPIRED` and publishes the corresponding
event. The same policy is used by HTTP and SQS.

## Tests

```bash
bun run test       # 52 unit tests, no Docker
bun run test:e2e   # 24 integration/concurrency tests, Docker required
```

The e2e suite starts real PostgreSQL and LocalStack containers and covers
schema constraints, atomicity, inbox redelivery, the 50-parallel-bet case, the
80/80 race, three application instances, refunds arriving before their bet,
retry exhaustion, concurrent outbox publishers, crash recovery and DLQ routing.
Every scenario asserts `wallet.balance == ledger sum`.

## Project layout

```
src/
  auth/         no-op AuthGuard + ProviderIdentityPort (extension point)
  config/       env validation, DI tokens
  database/     migration CLI
  health/       liveness, readiness, metrics
  messaging/    inbox/outbox, SQS client, publisher, consumer, workers
  migrations/   initial reversible migration
  platform/     unit of work, MikroORM config, HTTP filter, logging, metrics
  shared/       Money, clock, ids, domain errors
  wagering/     wager domain, use cases, persistence, controller
  wallets/      wallet domain, use cases, persistence, controller
test/           Testcontainers harness and e2e suite
docker/         LocalStack init script, nginx config
```

## Notes

- Authentication is intentionally not implemented; the decision, the Keycloak
  design that would be adopted and the code extension point are documented in
  [`ARCHITECTURE.md`](./ARCHITECTURE.md#17-authentication--decision-and-extension-point).
- Money is always a decimal string with scale 2; `number` is never used for
  monetary values.
- The model is multi-currency, but this delivery accepts only `BRL` at the edge.
