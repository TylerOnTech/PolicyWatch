import { randomBytes } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { AppDeps } from '../deps.js';
import { runWithContext } from '../lib/context.js';
import { checkPolicy, PolicyNotEnrolledError, type CheckResult } from '../monitoring/check-policy.js';
import { scheduleDueChecks } from '../monitoring/scheduler.js';
import { relayOutbox } from '../outbox/relay.js';
import { QUEUE_NAMES, type DeliveryJobData, type PolicyCheckJobData } from '../queues/queues.js';
import { processDelivery, type ProcessDeliveryResult } from '../webhooks/delivery-service.js';
import { sweepStuckDeliveries } from '../webhooks/sweeper.js';
import { writeHeartbeat, heartbeatKey } from './heartbeat.js';
import { BackgroundLoop } from './loop.js';

export interface WorkerOptions {
  /** Port for /health and /metrics; null disables the HTTP server (tests). */
  healthPort?: number | null;
  /** Disable individual loops (tests drive them explicitly). */
  loops?: Partial<Record<'scheduler' | 'outbox' | 'sweeper' | 'gauges' | 'heartbeat', boolean>>;
}

export interface WorkerHandle {
  workerId: string;
  stop(): Promise<void>;
  health(): Promise<WorkerHealth>;
  healthServer?: http.Server;
}

export interface WorkerHealth {
  status: 'ok' | 'degraded';
  workerId: string;
  uptimeSeconds: number;
  queues: Record<string, { running: boolean }>;
  loops: ReturnType<BackgroundLoop['status']>[];
}

/**
 * The worker process: two BullMQ consumers (policy checks, webhook deliveries) plus background loops
 * (scheduler, outbox relay, stuck-delivery sweeper, metrics gauges, heartbeat). Every component is
 * safe to run on multiple replicas.
 */
export async function startWorker(deps: AppDeps, opts: WorkerOptions = {}): Promise<WorkerHandle> {
  const { config, logger, metrics, queues } = deps;
  const workerId = `${os.hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const log = logger.child({ component: 'worker', workerId });
  const startedAt = new Date();
  const enabled = (name: keyof NonNullable<WorkerOptions['loops']>) => opts.loops?.[name] !== false;
  const loopDeps = { logger: log, metrics };

  const outboxLoop = new BackgroundLoop(
    'outbox-relay',
    config.outbox.pollIntervalMs,
    async () => (await relayOutbox(deps)).saturated,
    loopDeps,
  );

  const checkWorker = new Worker<PolicyCheckJobData, CheckResult>(
    QUEUE_NAMES.checks,
    (job: Job<PolicyCheckJobData>) =>
      runWithContext({ correlationId: job.data.correlationId }, async () => {
        try {
          return await checkPolicy({ ...deps, onEventsCommitted: () => outboxLoop.poke() }, job.data.policyId, {
            trigger: job.data.trigger,
            correlationId: job.data.correlationId,
          });
        } catch (err) {
          if (err instanceof PolicyNotEnrolledError) throw new UnrecoverableError(err.message);
          throw err;
        }
      }),
    { connection: queues.connection, prefix: queues.prefix, concurrency: config.worker.checkConcurrency },
  );

  const deliveryWorker = new Worker<DeliveryJobData, ProcessDeliveryResult>(
    QUEUE_NAMES.deliveries,
    (job: Job<DeliveryJobData>) =>
      runWithContext({ correlationId: job.data.correlationId }, () =>
        processDelivery(deps, job.data.deliveryId, { trigger: job.data.trigger }),
      ),
    { connection: queues.connection, prefix: queues.prefix, concurrency: config.worker.deliveryConcurrency },
  );

  for (const w of [checkWorker, deliveryWorker]) {
    w.on('error', (err) => log.error({ err, queue: w.name }, 'queue worker error'));
    w.on('failed', (job, err) =>
      log.warn({ queue: w.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: { message: err.message } }, 'job failed'),
    );
  }

  const schedulerLoop = new BackgroundLoop('scheduler', config.monitoring.schedulerTickMs, async () => {
    const n = await scheduleDueChecks(deps);
    if (n > 0) log.debug({ enqueued: n }, 'scheduled due policy checks');
    return n === config.monitoring.schedulerBatchSize;
  }, loopDeps);

  const sweeperLoop = new BackgroundLoop('delivery-sweeper', config.webhooks.sweeperIntervalMs, () => sweepStuckDeliveries(deps), loopDeps);

  const gaugeLoop = new BackgroundLoop('metrics-gauges', 15_000, async () => {
    for (const [name, queue] of [[QUEUE_NAMES.checks, queues.checks], [QUEUE_NAMES.deliveries, queues.deliveries]] as const) {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      for (const [state, value] of Object.entries(counts)) metrics.queueDepth.set({ queue: name, state }, value);
    }
    metrics.outboxPending.set(await deps.prisma.outboxMessage.count({ where: { status: 'PENDING' } }));
  }, loopDeps);

  const loops = [schedulerLoop, outboxLoop, sweeperLoop, gaugeLoop];
  const heartbeatTtl = Math.ceil((config.worker.heartbeatIntervalMs * 3) / 1000);
  const heartbeatLoop = new BackgroundLoop('heartbeat', config.worker.heartbeatIntervalMs, () =>
    writeHeartbeat(deps.redis, config.queuePrefix, {
      workerId,
      hostname: os.hostname(),
      pid: process.pid,
      startedAt: startedAt.toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      loops: loops.map((l) => {
        const s = l.status();
        return { name: s.name, lastSuccessAt: s.lastSuccessAt, consecutiveErrors: s.consecutiveErrors };
      }),
    }, heartbeatTtl),
  loopDeps);

  if (enabled('scheduler')) schedulerLoop.start();
  if (enabled('outbox')) outboxLoop.start();
  if (enabled('sweeper')) sweeperLoop.start();
  if (enabled('gauges')) gaugeLoop.start();
  if (enabled('heartbeat')) heartbeatLoop.start();

  const health = async (): Promise<WorkerHealth> => {
    const loopStatuses = [...loops, heartbeatLoop].map((l) => l.status());
    const queuesRunning = { [QUEUE_NAMES.checks]: { running: checkWorker.isRunning() }, [QUEUE_NAMES.deliveries]: { running: deliveryWorker.isRunning() } };
    const degraded = loopStatuses.some((l) => l.consecutiveErrors >= 3) || Object.values(queuesRunning).some((q) => !q.running);
    return {
      status: degraded ? 'degraded' : 'ok',
      workerId,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      queues: queuesRunning,
      loops: loopStatuses,
    };
  };

  let healthServer: http.Server | undefined;
  if (opts.healthPort !== null) {
    healthServer = http.createServer(async (req, res) => {
      try {
        if (req.url === '/health') {
          const h = await health();
          res.writeHead(h.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(h));
        } else if (req.url === '/metrics') {
          res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(await metrics.registry.metrics());
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        log.error({ err }, 'health endpoint failed');
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => healthServer!.listen(opts.healthPort ?? config.worker.healthPort, resolve));
  }

  log.info({ checkConcurrency: config.worker.checkConcurrency, deliveryConcurrency: config.worker.deliveryConcurrency }, 'worker started');

  return {
    workerId,
    healthServer,
    health,
    async stop() {
      log.info('worker stopping: draining loops and in-flight jobs');
      await Promise.all(loops.map((l) => l.stop()));
      // close() waits for active jobs to finish; new jobs stop being fetched immediately.
      await Promise.all([checkWorker.close(), deliveryWorker.close()]);
      await heartbeatLoop.stop();
      await deps.redis.del(heartbeatKey(config.queuePrefix, workerId)).catch(() => undefined);
      await new Promise<void>((resolve) => (healthServer ? healthServer.close(() => resolve()) : resolve()));
      log.info('worker stopped');
    },
  };
}
