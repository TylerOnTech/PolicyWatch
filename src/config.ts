import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_VERSION: z.string().default('1.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),

  API_PORT: int(0, 65535).default(3000),
  WORKER_HEALTH_PORT: int(0, 65535).default(3001),
  TRUST_PROXY: bool.default(false),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  QUEUE_PREFIX: z.string().min(1).default('policywatch'),

  // Authentication: bearer API keys. The admin key can do everything; the optional read-only key can
  // only call GET endpoints. Keys must be long random strings (see .env.example for generation).
  ADMIN_API_KEY: z.string().min(32, 'ADMIN_API_KEY must be at least 32 characters'),
  READONLY_API_KEY: z.string().min(32, 'READONLY_API_KEY must be at least 32 characters').optional(),

  // 32-byte key (base64) used to encrypt webhook signing secrets at rest with AES-256-GCM.
  SECRET_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'SECRET_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),

  // Carrier endpoints. By default all three point at the bundled carrier simulator.
  CARRIER_SIM_BASE_URL: z.string().default('http://127.0.0.1:4000'),
  CARRIER_ACME_BASE_URL: z.string().optional(),
  CARRIER_ACME_API_KEY: z.string().default('sim-acme-api-key'),
  CARRIER_BLUEBIRD_BASE_URL: z.string().optional(),
  CARRIER_BLUEBIRD_TOKEN: z.string().default('sim-bluebird-token'),
  CARRIER_CARDINAL_BASE_URL: z.string().optional(),
  CARRIER_CARDINAL_USERNAME: z.string().default('policywatch'),
  CARRIER_CARDINAL_PASSWORD: z.string().default('sim-cardinal-password'),
  CARRIER_TIMEOUT_MS: int(100, 120_000).default(5_000),
  CARRIER_MAX_RESPONSE_BYTES: int(1_024).default(1_048_576),

  // Monitoring
  DEFAULT_CHECK_INTERVAL_SECONDS: int(10).default(3_600),
  MIN_CHECK_INTERVAL_SECONDS: int(1).default(60),
  CHECK_FAILURE_BACKOFF_BASE_SECONDS: int(1).default(30),
  SCHEDULER_TICK_MS: int(100).default(5_000),
  SCHEDULER_BATCH_SIZE: int(1, 10_000).default(100),
  SCHEDULER_LEASE_SECONDS: int(5).default(300),
  CHECK_CONCURRENCY: int(1, 100).default(5),

  // Outbox relay
  OUTBOX_POLL_INTERVAL_MS: int(50).default(1_000),
  OUTBOX_BATCH_SIZE: int(1, 1_000).default(50),

  // Webhook delivery
  WEBHOOK_TIMEOUT_MS: int(100, 60_000).default(5_000),
  WEBHOOK_MAX_ATTEMPTS: int(1, 25).default(8),
  WEBHOOK_BACKOFF_BASE_MS: int(10).default(2_000),
  WEBHOOK_BACKOFF_MAX_MS: int(100).default(15 * 60_000),
  WEBHOOK_LOCK_SECONDS: int(5).default(60),
  WEBHOOK_REQUIRE_HTTPS: bool.optional(),
  // Hostnames exempt from the private-network SSRF block. Development/test only (e.g. "mock-receiver").
  WEBHOOK_ALLOWED_HOSTS: csv.default([]),
  DELIVERY_CONCURRENCY: int(1, 200).default(10),
  SWEEPER_INTERVAL_MS: int(100).default(15_000),
  SWEEPER_STALE_AFTER_MS: int(100).default(60_000),

  WORKER_HEARTBEAT_INTERVAL_MS: int(100).default(10_000),
  SHUTDOWN_TIMEOUT_MS: int(1_000).default(25_000),
});

export type RawEnv = z.input<typeof EnvSchema>;

export interface CarrierEndpointConfig {
  acme: { baseUrl: string; apiKey: string };
  bluebird: { baseUrl: string; token: string };
  cardinal: { baseUrl: string; username: string; password: string };
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  version: string;
  log: { level: string; pretty: boolean };
  api: { port: number; trustProxy: boolean };
  worker: {
    healthPort: number;
    heartbeatIntervalMs: number;
    checkConcurrency: number;
    deliveryConcurrency: number;
  };
  databaseUrl: string;
  redisUrl: string;
  queuePrefix: string;
  auth: { adminApiKey: string; readonlyApiKey: string | undefined };
  secretEncryptionKey: Buffer;
  carriers: CarrierEndpointConfig;
  monitoring: {
    defaultCheckIntervalSeconds: number;
    minCheckIntervalSeconds: number;
    failureBackoffBaseSeconds: number;
    schedulerTickMs: number;
    schedulerBatchSize: number;
    schedulerLeaseSeconds: number;
  };
  outbox: { pollIntervalMs: number; batchSize: number };
  webhooks: {
    timeoutMs: number;
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    lockSeconds: number;
    requireHttps: boolean;
    allowedHosts: string[];
    sweeperIntervalMs: number;
    sweeperStaleAfterMs: number;
  };
  shutdownTimeoutMs: number;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  const sim = e.CARRIER_SIM_BASE_URL.replace(/\/+$/, '');
  const isProd = e.NODE_ENV === 'production';

  return Object.freeze({
    env: e.NODE_ENV,
    version: e.SERVICE_VERSION,
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
    api: { port: e.API_PORT, trustProxy: e.TRUST_PROXY },
    worker: {
      healthPort: e.WORKER_HEALTH_PORT,
      heartbeatIntervalMs: e.WORKER_HEARTBEAT_INTERVAL_MS,
      checkConcurrency: e.CHECK_CONCURRENCY,
      deliveryConcurrency: e.DELIVERY_CONCURRENCY,
    },
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    queuePrefix: e.QUEUE_PREFIX,
    auth: { adminApiKey: e.ADMIN_API_KEY, readonlyApiKey: e.READONLY_API_KEY },
    secretEncryptionKey: Buffer.from(e.SECRET_ENCRYPTION_KEY, 'base64'),
    carriers: {
      acme: { baseUrl: e.CARRIER_ACME_BASE_URL ?? `${sim}/acme`, apiKey: e.CARRIER_ACME_API_KEY },
      bluebird: { baseUrl: e.CARRIER_BLUEBIRD_BASE_URL ?? `${sim}/bluebird`, token: e.CARRIER_BLUEBIRD_TOKEN },
      cardinal: {
        baseUrl: e.CARRIER_CARDINAL_BASE_URL ?? `${sim}/cardinal`,
        username: e.CARRIER_CARDINAL_USERNAME,
        password: e.CARRIER_CARDINAL_PASSWORD,
      },
      timeoutMs: e.CARRIER_TIMEOUT_MS,
      maxResponseBytes: e.CARRIER_MAX_RESPONSE_BYTES,
    },
    monitoring: {
      defaultCheckIntervalSeconds: e.DEFAULT_CHECK_INTERVAL_SECONDS,
      minCheckIntervalSeconds: e.MIN_CHECK_INTERVAL_SECONDS,
      failureBackoffBaseSeconds: e.CHECK_FAILURE_BACKOFF_BASE_SECONDS,
      schedulerTickMs: e.SCHEDULER_TICK_MS,
      schedulerBatchSize: e.SCHEDULER_BATCH_SIZE,
      schedulerLeaseSeconds: e.SCHEDULER_LEASE_SECONDS,
    },
    outbox: { pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS, batchSize: e.OUTBOX_BATCH_SIZE },
    webhooks: {
      timeoutMs: e.WEBHOOK_TIMEOUT_MS,
      maxAttempts: e.WEBHOOK_MAX_ATTEMPTS,
      backoffBaseMs: e.WEBHOOK_BACKOFF_BASE_MS,
      backoffMaxMs: e.WEBHOOK_BACKOFF_MAX_MS,
      lockSeconds: e.WEBHOOK_LOCK_SECONDS,
      requireHttps: e.WEBHOOK_REQUIRE_HTTPS ?? isProd,
      allowedHosts: e.WEBHOOK_ALLOWED_HOSTS,
      sweeperIntervalMs: e.SWEEPER_INTERVAL_MS,
      sweeperStaleAfterMs: e.SWEEPER_STALE_AFTER_MS,
    },
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  });
}
