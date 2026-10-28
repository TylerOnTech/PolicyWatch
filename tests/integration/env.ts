export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://policywatch:policywatch@127.0.0.1:5432/policywatch_test?schema=public';

// A dedicated logical Redis DB so tests never touch development queues.
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

export const ADMIN_KEY = 'test-admin-key-0123456789abcdefghijklmnop';
export const READONLY_KEY = 'test-readonly-key-0123456789abcdefghijklm';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
  QUEUE_PREFIX: 'pwtest',
  ADMIN_API_KEY: ADMIN_KEY,
  READONLY_API_KEY: READONLY_KEY,
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  CARRIER_TIMEOUT_MS: '400',
  MIN_CHECK_INTERVAL_SECONDS: '1',
  CHECK_FAILURE_BACKOFF_BASE_SECONDS: '30',
  WEBHOOK_TIMEOUT_MS: '400',
  WEBHOOK_MAX_ATTEMPTS: '3',
  WEBHOOK_BACKOFF_BASE_MS: '40',
  WEBHOOK_BACKOFF_MAX_MS: '200',
  WEBHOOK_LOCK_SECONDS: '10',
  WEBHOOK_REQUIRE_HTTPS: 'false',
  WEBHOOK_ALLOWED_HOSTS: '127.0.0.1',
  SWEEPER_STALE_AFTER_MS: '200',
  OUTBOX_POLL_INTERVAL_MS: '50',
  SCHEDULER_TICK_MS: '100',
  WORKER_HEARTBEAT_INTERVAL_MS: '200',
};
