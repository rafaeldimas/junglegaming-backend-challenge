/**
 * Optional load experiment (`bun run test:load`).
 *
 * It is intentionally small and honest: it measures a mixed workload against a
 * running deployment (default: the Compose stack behind nginx), reports
 * throughput, latency percentiles, status distribution and verifies that every
 * wallet still reconciles at the end.
 *
 * Environment:
 *   BASE_URL            default http://localhost:8080
 *   CONCURRENCY         default 32
 *   DURATION_SECONDS    default 15
 *   WALLETS             default 20
 *   INITIAL_BALANCE     default 1000.00
 *   BET_AMOUNT          default 1.00
 *   REPLAY_RATIO        default 0.1 (share of requests that replay a known key)
 */
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS ?? 15);
const WALLETS = Number(process.env.WALLETS ?? 20);
const INITIAL_BALANCE = process.env.INITIAL_BALANCE ?? '1000.00';
const BET_AMOUNT = process.env.BET_AMOUNT ?? '1.00';
const REPLAY_RATIO = Number(process.env.REPLAY_RATIO ?? 0.1);

interface Sample {
  latencyMs: number;
  status: number;
  failureCode?: string;
}

interface Wallet {
  id: string;
  playerId: string;
}

const samples: Sample[] = [];
interface KnownRequest {
  idempotencyKey: string;
  body: Record<string, unknown>;
}

const knownRequests: KnownRequest[] = [];

async function main(): Promise<void> {
  console.log(`load test against ${BASE_URL}`);
  console.log(
    `concurrency=${CONCURRENCY} duration=${DURATION_SECONDS}s wallets=${WALLETS} ` +
      `bet=${BET_AMOUNT} replayRatio=${REPLAY_RATIO}`,
  );

  const wallets = await createWallets(WALLETS);
  console.log(`${wallets.length} wallets created`);

  const startedAt = performance.now();
  const deadline = startedAt + DURATION_SECONDS * 1_000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, worker) => runWorker(worker, wallets, deadline)),
  );
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;

  report(elapsedSeconds);
  await verifyReconciliation(wallets);
}

async function createWallets(count: number): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  for (let index = 0; index < count; index += 1) {
    const playerId = randomUUID();
    const response = await fetch(`${BASE_URL}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: INITIAL_BALANCE, currency: 'BRL' },
      }),
    });
    if (response.status !== 201) {
      throw new Error(`wallet creation failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { id: string };
    wallets.push({ id: body.id, playerId });
  }
  return wallets;
}

async function runWorker(worker: number, wallets: Wallet[], deadline: number): Promise<void> {
  let sequence = 0;
  while (performance.now() < deadline) {
    const wallet = wallets[(worker + sequence) % wallets.length]!;
    const replay = knownRequests.length > 0 && Math.random() < REPLAY_RATIO;
    const known = replay
      ? knownRequests[Math.floor(Math.random() * knownRequests.length)]!
      : undefined;
    const idempotencyKey = known?.idempotencyKey ?? `provider-load:${randomUUID()}`;
    const requestBody =
      known?.body ??
      {
        providerId: 'provider-load',
        externalTransactionId: `load-${worker}-${sequence}-${randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-${worker}-${sequence}`,
        gameId: 'load-test',
        kind: 'BET',
        money: { amount: BET_AMOUNT, currency: 'BRL' },
      };

    const startedAt = performance.now();
    let status = 0;
    let failureCode: string | undefined;
    try {
      const response = await fetch(`${BASE_URL}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });
      status = response.status;
      const payload = (await response.json()) as { failureCode?: string };
      failureCode = payload.failureCode;
      if (known === undefined && (status === 201 || status === 422)) {
        knownRequests.push({ idempotencyKey, body: requestBody });
      }
    } catch (error) {
      status = -1;
      failureCode = (error as Error).message;
    }

    samples.push({ latencyMs: performance.now() - startedAt, status, failureCode });
    sequence += 1;
  }
}

function report(elapsedSeconds: number): void {
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const percentile = (value: number): number => {
    if (latencies.length === 0) {
      return 0;
    }
    const index = Math.min(latencies.length - 1, Math.ceil((value / 100) * latencies.length) - 1);
    return latencies[index]!;
  };

  const byStatus = new Map<string, number>();
  for (const sample of samples) {
    byStatus.set(String(sample.status), (byStatus.get(String(sample.status)) ?? 0) + 1);
  }
  const failures = samples.filter((sample) => sample.status < 200 || sample.status >= 500).length;
  const conflicts = samples.filter((sample) => sample.status === 409).length;
  const rejections = samples.filter((sample) => sample.status === 422);
  const rejectionCodes = new Map<string, number>();
  for (const rejection of rejections) {
    const code = rejection.failureCode ?? 'UNKNOWN';
    rejectionCodes.set(code, (rejectionCodes.get(code) ?? 0) + 1);
  }

  console.log('\n--- results ---');
  console.log(`requests:    ${samples.length}`);
  console.log(`throughput:  ${(samples.length / elapsedSeconds).toFixed(1)} req/s`);
  console.log(`p50:         ${percentile(50).toFixed(1)} ms`);
  console.log(`p95:         ${percentile(95).toFixed(1)} ms`);
  console.log(`p99:         ${percentile(99).toFixed(1)} ms`);
  console.log(`error rate:  ${((failures / Math.max(1, samples.length)) * 100).toFixed(2)}%`);
  console.log(`409:         ${conflicts}`);
  console.log(
    `422:         ${rejections.length} ${rejectionCodes.size > 0 ? JSON.stringify(Object.fromEntries(rejectionCodes)) : ''}`,
  );
  console.log(`statuses:    ${JSON.stringify(Object.fromEntries(byStatus))}`);
}

async function verifyReconciliation(wallets: Wallet[]): Promise<void> {
  let inconsistent = 0;
  for (const wallet of wallets) {
    const response = await fetch(`${BASE_URL}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
    const body = (await response.json()) as { consistent: boolean; checkedEntries: number };
    if (!body.consistent) {
      inconsistent += 1;
      console.error(`wallet ${wallet.id} is inconsistent`);
    }
  }
  console.log(`reconciliation: ${wallets.length - inconsistent}/${wallets.length} consistent`);
  if (inconsistent > 0) {
    process.exitCode = 1;
  }
}

await main();
