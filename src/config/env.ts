import { z } from 'zod';

const booleanFromString = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) => (typeof value === 'boolean' ? value : value.toLowerCase() === 'true'));

const intFromString = (defaultValue: number, min = 0) =>
  z
    .union([z.number(), z.string()])
    .default(defaultValue)
    .transform((value) => (typeof value === 'number' ? value : Number.parseInt(value, 10)))
    .pipe(z.number().int().min(min));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromString(3000, 1),
  DATABASE_URL: z.string().min(1).default('postgresql://jungle:jungle@localhost:5432/jungle'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  SQS_ENDPOINT: z.string().min(1).default('http://localhost:4566'),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_QUEUE_NAME: z.string().min(1).default('wager-transactions.fifo'),
  SQS_DLQ_NAME: z.string().min(1).default('wager-transactions-dlq.fifo'),
  /* Outbound integration events. Separate queue because SQS has no fan-out:
     mixing them with requests would make the request consumer read its own events. */
  SQS_EVENTS_QUEUE_NAME: z.string().min(1).default('wager-events.fifo'),
  SQS_WAIT_TIME_SECONDS: intFromString(20, 0),
  SQS_VISIBILITY_TIMEOUT_SECONDS: intFromString(30, 1),
  SQS_MAX_ATTEMPTS: intFromString(5, 1),
  SQS_CONSUMER_ENABLED: booleanFromString(true),
  QUEUE_AUTO_CREATE: booleanFromString(true),

  OUTBOX_PUBLISHER_ENABLED: booleanFromString(true),
  OUTBOX_POLL_INTERVAL_MS: intFromString(100, 10),
  OUTBOX_BATCH_SIZE: intFromString(200, 1),
  OUTBOX_PUBLISH_CONCURRENCY: intFromString(8, 1),

  PENDING_REFERENCE_WORKER_ENABLED: booleanFromString(true),
  PENDING_REFERENCE_POLL_INTERVAL_MS: intFromString(5000, 10),
  PENDING_REFERENCE_BATCH_SIZE: intFromString(50, 1),
  PENDING_REFERENCE_MAX_ATTEMPTS: intFromString(5, 1),
  PENDING_REFERENCE_TTL_MINUTES: intFromString(15, 1),

  SHUTDOWN_GRACE_MS: intFromString(10_000, 0),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | undefined;

/** Fail-fast environment parsing. Tests may pass explicit overrides. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (source === process.env && cached !== undefined) {
    return cached;
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  if (source === process.env) {
    cached = parsed.data;
  }
  return parsed.data;
}

export function resetEnvCacheForTests(): void {
  cached = undefined;
}
