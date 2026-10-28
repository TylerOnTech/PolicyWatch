import { execFileSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './env.js';

/**
 * Integration tests run against real PostgreSQL and Redis (see tests/integration/env.ts for the
 * defaults, or set TEST_DATABASE_URL / TEST_REDIS_URL). The schema is applied with the same
 * `prisma migrate deploy` used in production, so migrations are exercised too.
 */
export default async function setup() {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  await redis.flushdb();
  await redis.quit();
}
