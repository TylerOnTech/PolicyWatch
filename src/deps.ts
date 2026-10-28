import { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { createCarrierRegistry, type CarrierRegistry } from './carriers/registry.js';
import type { AppConfig } from './config.js';
import { createLogger, type Logger } from './lib/logger.js';
import { createMetrics, type Metrics } from './lib/metrics.js';
import { closeQueues, createQueues, createRedis, type Queues } from './queues/queues.js';
import { DestinationPolicy } from './webhooks/ssrf.js';

/**
 * Explicit dependency container shared by the API, the worker, scripts and tests. Nothing in the
 * application reaches for module-level singletons, so tests can build isolated instances.
 */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  queues: Queues;
  carriers: CarrierRegistry;
  metrics: Metrics;
  destinations: DestinationPolicy;
  clock: () => Date;
}

export interface DepsOverrides {
  logger?: Logger;
  carriers?: CarrierRegistry;
  destinations?: DestinationPolicy;
  clock?: () => Date;
  defaultMetrics?: boolean;
  service?: string;
}

export function createDeps(config: AppConfig, overrides: DepsOverrides = {}): AppDeps {
  const logger =
    overrides.logger ??
    createLogger({ level: config.log.level, pretty: config.log.pretty, service: overrides.service ?? 'policywatch', version: config.version });

  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const redis = createRedis(config.redisUrl);
  redis.on('error', (err) => logger.warn({ err: { message: err.message } }, 'redis connection error'));
  const queues = createQueues(redis, config.queuePrefix);

  if (config.env === 'production' && config.webhooks.allowedHosts.length > 0) {
    logger.warn({ allowedHosts: config.webhooks.allowedHosts }, 'WEBHOOK_ALLOWED_HOSTS bypasses SSRF checks; do not use in production');
  }

  return {
    config,
    logger,
    prisma,
    redis,
    queues,
    carriers: overrides.carriers ?? createCarrierRegistry(config.carriers),
    metrics: createMetrics({ defaultMetrics: overrides.defaultMetrics }),
    destinations:
      overrides.destinations ??
      new DestinationPolicy({ requireHttps: config.webhooks.requireHttps, allowedHosts: config.webhooks.allowedHosts }),
    clock: overrides.clock ?? (() => new Date()),
  };
}

export async function closeDeps(deps: AppDeps): Promise<void> {
  await closeQueues(deps.queues);
  await Promise.allSettled([deps.prisma.$disconnect(), deps.redis.quit()]);
}
