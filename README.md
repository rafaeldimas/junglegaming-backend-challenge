# Distributed Wagering Processor

Serviço NestJS que processa operações de apostas de múltiplos provedores sobre
wallets de jogadores, com dinheiro exato, idempotência persistente, garantia de
concorrência por wallet, transactional outbox e consumo SQS at-least-once.

As decisões de arquitetura, trade-offs e limitações estão em
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

- Bun 1.x · TypeScript (strict) · NestJS 12
- PostgreSQL 16 + MikroORM 7 (migrations versionadas e reversíveis)
- AWS SQS FIFO via LocalStack 3.8
- decimal.js para dinheiro · ids UUIDv7
- logs JSON com pino · métricas com prom-client
- runner de testes do Bun + Testcontainers (PostgreSQL e SQS reais)

## Início rápido (Docker Compose)

Requer Docker com Compose v2.

```bash
docker compose up --build
```

Isso sobe PostgreSQL, LocalStack (com as filas e a DLQ já criadas), executa as
migrations e inicia a API atrás do nginx.

- API: <http://localhost:8080>
- Health: <http://localhost:8080/health/ready>
- Métricas: <http://localhost:8080/metrics>
- LocalStack: <http://localhost:4566>

Para o cenário com múltiplas instâncias:

```bash
docker compose up -d --build --scale app=3
```

O container da aplicação não publica porta no host de propósito; o nginx resolve
`app` a cada requisição via DNS do Docker, distribuindo as chamadas entre as
réplicas.

Para parar e remover os volumes:

```bash
docker compose down -v
```

## Desenvolvimento local

```bash
bun install
cp .env.example .env
```

Suba PostgreSQL e LocalStack (ou use os seus):

```bash
docker run -d --name jungle-pg \
  -e POSTGRES_USER=jungle -e POSTGRES_PASSWORD=jungle -e POSTGRES_DB=jungle \
  -p 5432:5432 postgres:16-alpine

docker run -d --name jungle-localstack \
  -e SERVICES=sqs -p 4566:4566 localstack/localstack:3.8
```

Aplique o schema e inicie a aplicação:

```bash
bun run migration:up
bun run start:dev
```

A aplicação cria as filas FIFO no boot quando elas não existem
(`QUEUE_AUTO_CREATE=true`).

## Comandos

| Comando | Descrição |
|---|---|
| `bun run start:dev` | modo watch |
| `bun run start` | inicia uma vez |
| `bun run build` | compila para `dist/` |
| `bun run start:prod` | executa o build com Bun |
| `bun run migration:up` | aplica migrations pendentes |
| `bun run migration:down` | reverte a última migration |
| `bun run migration:list` | lista migrations pendentes |
| `bun run test` | testes unitários |
| `bun run test:e2e` | testes de integração/concorrência (requer Docker) |
| `bun run test:all` | unitários + e2e |
| `bun run test:load` | experimento de carga opcional contra uma implantação em execução |
| `bun run lint` | oxlint (type-aware) |
| `bun run format` | prettier |

A configuração é validada no boot (veja `.env.example`); valores inválidos
falham rápido com uma mensagem legível.

## API

### Criar wallet

```bash
curl -X POST http://localhost:8080/wallets \
  -H 'content-type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "100.00", "currency": "BRL" }
  }'
```

O saldo inicial, quando maior que zero, cria uma transação interna `OPENING` e o
lançamento `CREDIT` correspondente na mesma transação SQL. Criar uma segunda
wallet para o mesmo `playerId + currency` retorna `409`.

### Submeter uma transação

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

Repetir a requisição retorna o resultado original com
`"idempotentReplay": true`. Reutilizar a chave com payload diferente retorna
`409 IDEMPOTENCY_CONFLICT`.

### Consultas

```bash
curl http://localhost:8080/wallets/<wallet-id>
curl 'http://localhost:8080/wallets/<wallet-id>/ledger?limit=50'
curl http://localhost:8080/wagering/transactions/<transaction-id>
curl http://localhost:8080/providers/provider-a/wagering/transactions/transaction-123
curl -X POST http://localhost:8080/wallets/<wallet-id>/reconciliation
```

O cursor do ledger é opaco e estável (`created_at, id`); use o `nextCursor`
retornado para buscar a próxima página.

### Códigos de status

| Código | Significado |
|---|---|
| `201` | processada |
| `200` | replay idempotente / consulta bem-sucedida |
| `202` | aceita, aguardando referência (`PENDING_REFERENCE`) |
| `400` | payload inválido |
| `404` | wallet ou transação não encontrada |
| `409` | conflito de idempotência, id externo ou wallet duplicada |
| `422` | rejeição de negócio (o corpo tem `failureCode`) |
| `503` | falha transitória de infraestrutura |

Rejeições de negócio são persistidas com um `failureCode` legível por máquina; a
tabela completa está em [`ARCHITECTURE.md`](./ARCHITECTURE.md) (seção 15).

## SQS

O consumidor lê `wager-transactions.fifo`; falhas permanentes vão para
`wager-transactions-dlq.fifo`. Eventos de integração de saída são publicados em
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

Enviar uma mensagem com a AWS CLI contra o LocalStack:

```bash
aws --endpoint-url=http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <wallet-id> \
  --message-deduplication-id "msg-123" \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...}}'
```

Eventos publicados pela outbox: `WagerTransactionProcessed`,
`WagerTransactionRejected`, `WalletBalanceChanged` e
`WagerTransactionPendingReference`. Cada envelope carrega `eventId`,
`eventType`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt`,
`version` e `data`; consumidores devem deduplicar por `eventId`.

## Referências fora de ordem

`REFUND` e `ROLLBACK` enviados antes da referência são aceitos (`202`) e
persistidos como `PENDING_REFERENCE`. Um worker agendado tenta novamente após
5s, 15s, 45s, 2m e 5m, por até 5 tentativas ou 15 minutos de TTL; depois rejeita
com `REFERENCE_NOT_FOUND` / `REFERENCE_EXPIRED` e publica o evento
correspondente. A mesma política vale para HTTP e SQS.

## Testes

```bash
bun run test       # 78 testes unitários com o runner do Bun, sem Docker
bun run test:e2e   # 39 testes de integração/concorrência, requer Docker
```

As duas suítes rodam com `bun test`. Um preload de teste (`test/preload.ts`)
substitui o módulo nativo `ssh2` do Testcontainers — o Bun 1.4.4 quebra ao
carregá-lo — e silencia o logger. O e2e sobe PostgreSQL e LocalStack reais e
cobre constraints do schema, atomicidade, redelivery do inbox, o caso das 50
apostas em paralelo, a corrida 80/80, três instâncias, refund antes da aposta,
esgotamento de retry, publishers concorrentes, recuperação após restart, DLQ e
a API HTTP. Todo cenário relevante verifica `wallet.balance == soma do ledger`.

## Experimento de carga (opcional)

`bun run test:load` dispara uma carga mista contra uma implantação em execução e
imprime throughput, p50/p95/p99, distribuição de status e uma reconciliação
final de todas as wallets. É um experimento de correção/observabilidade, não um
benchmark.

```bash
docker compose up -d --build --scale app=3
CONCURRENCY=32 DURATION_SECONDS=15 WALLETS=20 bun run test:load
```

### Ambiente e metodologia

- máquina Linux local, Docker Compose: 3 réplicas da aplicação (Bun 1.4.4
  alpine) atrás do nginx, PostgreSQL 16 e LocalStack 3.8 (SQS), tudo no mesmo
  host;
- 20 wallets com `1000.00 BRL`, apostas de `1.00 BRL`, 32 clientes concorrentes
  por 15 segundos, 10% das requisições repetindo uma chave de idempotência já
  conhecida;
- latência medida no cliente por requisição; `422`/`409` contados separadamente
  de erros (`5xx` e falhas de rede); outbox lag lido do PostgreSQL e de
  `/metrics` (as métricas são por instância, então a consulta ao banco é a visão
  agregada).

### Resultado da execução registrada

| Métrica | Valor |
|---|---|
| Requisições | 3.878 |
| Throughput | 256,8 req/s |
| p50 / p95 / p99 | 113,8 ms / 260,8 ms / 332,5 ms |
| Taxa de erro | 0,00% |
| Conflitos (`409`) | 0 |
| Rejeições de negócio (`422`) | 0 |
| Processadas / replays | 3.478 / 400 |
| Reconciliação | 20/20 wallets consistentes |

Outbox: o burst produz cerca de dois eventos por transação (~500 eventos/s),
mais do que o LocalStack consegue absorver. Ao final da execução havia ~1.982
eventos pendentes com lag de ~9 s; o backlog drenou para **0 pendentes / 0 s de
lag em 30 segundos** após o fim da carga. O publisher está ajustado com
`OUTBOX_BATCH_SIZE=200`, `OUTBOX_POLL_INTERVAL_MS=100` e
`OUTBOX_PUBLISH_CONCURRENCY=8` (ordem preservada por agregado, agregados
diferentes publicados em paralelo). Aumentar a concorrência para 16 não
melhorou o resultado, o que aponta o broker local — e não a aplicação — como
gargalo. Os números são indicativos deste ambiente e não são uma promessa de
capacidade em produção.

## Estrutura do projeto

```
src/
  auth/         AuthGuard no-op + ProviderIdentityPort (ponto de extensão)
  config/       validação de env, tokens de DI
  database/     CLI de migrations
  health/       liveness, readiness, métricas
  messaging/    inbox/outbox, cliente SQS, publisher, consumer, workers
  migrations/   migration inicial reversível
  platform/     unit of work, configuração MikroORM, filtro HTTP, logs, métricas
  shared/       Money, clock, ids, erros de domínio
  wagering/     domínio, casos de uso, persistência e controller de apostas
  wallets/      domínio, casos de uso, persistência e controller de wallets
scripts/        experimento de carga opcional
test/           harness com Testcontainers + suíte e2e
docker/         bootstrap das filas no LocalStack, configuração do nginx
```

## Por que os imports usam a extensão `.js`?

O projeto é ESM (`"type": "module"` no `package.json`) e o TypeScript compila com
`module`/`moduleResolution: nodenext`. Nesse modo, o Node exige **extensão
explícita** em imports relativos: o arquivo emitido é `dist/foo.js`, então o
import no código-fonte precisa apontar para `./foo.js` mesmo que o arquivo seja
`foo.ts`. O TypeScript resolve `./foo.js` para `foo.ts` na compilação e mantém o
caminho no output — é o padrão recomendado para ESM + Node, e também funciona no
Bun.

Remover as extensões exigiria mudar para CommonJS (`module: commonjs`,
`"type": "commonjs"`) ou para um bundler. Isso foi descartado porque:
`uuid` v14 é ESM-only, o runtime alvo é Bun/Node ESM e o modo `nodenext` também
verifica corretamente as condições de exportação dos pacotes. Ou seja, a
extensão `.js` é intencional e não um resquício; o código compilado roda tanto
com Bun quanto com Node.

## Observações

- A autenticação não foi implementada; a decisão, o desenho com Keycloak que
  seria adotado e o ponto de extensão no código estão em
  [`ARCHITECTURE.md`](./ARCHITECTURE.md) (seção 17).
- Dinheiro é sempre string decimal com escala 2; `number` nunca é usado para
  valores monetários.
- O modelo é multi-moeda, mas esta entrega aceita apenas `BRL` na borda.
