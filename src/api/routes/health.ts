import { Router } from 'express';
import type { AppDeps } from '../../deps.js';
import { readHeartbeats } from '../../worker/heartbeat.js';

type ComponentStatus = { status: 'up' | 'down'; latencyMs: number; error?: string };

async function probe(fn: () => Promise<unknown>): Promise<ComponentStatus> {
  const t0 = performance.now();
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000))]);
    return { status: 'up', latencyMs: Math.round(performance.now() - t0) };
  } catch (err) {
    return { status: 'down', latencyMs: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : 'error' };
  }
}

export function healthRouter(deps: AppDeps): Router {
  const router = Router();
  const startedAt = Date.now();

  /** Liveness: the process is serving HTTP. No dependency checks (container restart signal). */
  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /**
   * Readiness + system view. 503 only when the API itself cannot work (database or Redis down).
   * Missing or unhealthy workers make the system "degraded" but the API stays in rotation.
   */
  router.get('/health', async (_req, res) => {
    const [database, redis] = await Promise.all([
      probe(() => deps.prisma.$queryRaw`SELECT 1`),
      probe(() => deps.redis.ping()),
    ]);
    const heartbeats = redis.status === 'up' ? await readHeartbeats(deps.redis, deps.config.queuePrefix).catch(() => []) : [];
    const unhealthyWorkers = heartbeats.filter((h) => h.loops.some((l) => l.consecutiveErrors >= 3));

    const down = database.status === 'down' || redis.status === 'down';
    const status = down ? 'down' : heartbeats.length === 0 || unhealthyWorkers.length > 0 ? 'degraded' : 'ok';

    res.status(down ? 503 : 200).json({
      status,
      version: deps.config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks: {
        database,
        redis,
        workers: {
          status: heartbeats.length === 0 ? 'none' : unhealthyWorkers.length > 0 ? 'degraded' : 'up',
          count: heartbeats.length,
          instances: heartbeats.map((h) => ({
            workerId: h.workerId,
            lastHeartbeatAt: h.lastHeartbeatAt,
            loops: h.loops,
          })),
        },
      },
    });
  });

  return router;
}
