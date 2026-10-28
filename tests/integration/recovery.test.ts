import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { relayOutbox } from '../../src/outbox/relay.js';
import { processDelivery } from '../../src/webhooks/delivery-service.js';
import { createSubscription } from '../../src/webhooks/subscriptions.js';
import { sweepStuckDeliveries } from '../../src/webhooks/sweeper.js';
import { startWorker, type WorkerHandle } from '../../src/worker/worker.js';
import { readHeartbeats } from '../../src/worker/heartbeat.js';
import { enrollPolicy } from '../../src/monitoring/enrollment.js';
import { enqueueCheck } from '../../src/queues/queues.js';
import {
  check,
  createTestContext,
  enrollWithBaseline,
  mutate,
  resetState,
  startWebhookTarget,
  waitFor,
  type TestContext,
  type WebhookTarget,
} from './helpers.js';

let ctx: TestContext;
let target: WebhookTarget;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
  target = await startWebhookTarget();
});
afterEach(async () => {
  await target.close();
});

async function relayedCancellation() {
  await createSubscription(ctx.deps, { url: `${target.url}/hook`, eventTypes: ['*'], carrierIds: [] });
  const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
  mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
  await check(ctx.deps, policy.id);
  await relayOutbox(ctx.deps);
  return ctx.deps.prisma.webhookDelivery.findFirstOrThrow();
}

describe('stuck delivery recovery (sweeper)', () => {
  it('re-enqueues a delivery whose queue job was lost after the outbox commit', async () => {
    const delivery = await relayedCancellation();
    await ctx.deps.queues.deliveries.obliterate({ force: true }); // e.g. Redis data loss
    await ctx.deps.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { nextAttemptAt: new Date(Date.now() - 5_000), enqueuedAt: new Date(Date.now() - 5_000) },
    });

    expect(await sweepStuckDeliveries(ctx.deps)).toBe(1);
    const jobs = await ctx.deps.queues.deliveries.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.deliveryId).toBe(delivery.id);

    // The sweeper does not re-enqueue the same delivery again until staleness elapses.
    expect(await sweepStuckDeliveries(ctx.deps)).toBe(0);
  });

  it('recovers a delivery left IN_PROGRESS by a crashed worker, reusing the unrecorded attempt number', async () => {
    const delivery = await relayedCancellation();
    // Enqueued 70 s ago; a worker claimed attempt 1 with a 60 s lock, then died before recording anything.
    await ctx.deps.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'IN_PROGRESS',
        attemptCount: 1,
        enqueuedAt: new Date(Date.now() - 70_000),
        lockedUntil: new Date(Date.now() - 1_000),
      },
    });
    expect(await sweepStuckDeliveries(ctx.deps)).toBe(1);

    const result = await processDelivery(ctx.deps, delivery.id, { trigger: 'AUTOMATIC' });
    expect(result).toMatchObject({ status: 'SUCCEEDED', attemptNumber: 1 });
    const attempts = await ctx.deps.prisma.deliveryAttempt.findMany({ where: { deliveryId: delivery.id } });
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1]);
  });

  it('leaves a live in-progress delivery alone', async () => {
    const delivery = await relayedCancellation();
    await ctx.deps.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'IN_PROGRESS', attemptCount: 1, lockedUntil: new Date(Date.now() + 30_000) },
    });
    expect(await sweepStuckDeliveries(ctx.deps)).toBe(0);
    expect(await processDelivery(ctx.deps, delivery.id, { trigger: 'AUTOMATIC' })).toEqual({ status: 'SKIPPED', reason: 'NOT_CLAIMABLE' });
    expect(target.requests).toHaveLength(0);
  });

  it('enqueue failures after commit are survivable: the delivery row is the source of truth', async () => {
    await createSubscription(ctx.deps, { url: `${target.url}/hook`, eventTypes: ['*'], carrierIds: [] });
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
    await check(ctx.deps, policy.id);

    const addBulk = ctx.deps.queues.deliveries.addBulk.bind(ctx.deps.queues.deliveries);
    ctx.deps.queues.deliveries.addBulk = async () => {
      throw new Error('simulated Redis outage');
    };
    try {
      expect((await relayOutbox(ctx.deps)).deliveriesCreated).toBe(1); // commit succeeded, enqueue did not
    } finally {
      ctx.deps.queues.deliveries.addBulk = addBulk;
    }
    expect(await ctx.deps.queues.deliveries.count()).toBe(0);
    await ctx.deps.prisma.webhookDelivery.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 5_000), enqueuedAt: new Date(Date.now() - 5_000) } });
    expect(await sweepStuckDeliveries(ctx.deps)).toBe(1);
  });
});

describe('end to end through BullMQ workers', () => {
  let worker: WorkerHandle | undefined;
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });

  it('enrollment → baseline → carrier cancellation → event → failed webhook → retry → success', async () => {
    target.respond = (_req, i) => (i === 0 ? 503 : 200);
    worker = await startWorker(ctx.deps, { healthPort: null });
    await createSubscription(ctx.deps, { url: `${target.url}/hook`, eventTypes: ['POLICY_CANCELLED'], carrierIds: [] });

    const { policy } = await enrollPolicy(ctx.deps, { carrierId: 'acme', externalPolicyId: 'acm-auto-100234' }, 'e2e-test');
    expect(policy.externalPolicyId).toBe('ACM-AUTO-100234');
    await waitFor(async () => (await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } })).currentVersion === 1);

    mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
    await enqueueCheck(ctx.deps.queues, { policyId: policy.id, trigger: 'MANUAL', correlationId: 'e2e-test' });

    const delivered = await waitFor(async () => {
      const d = await ctx.deps.prisma.webhookDelivery.findFirst({ include: { attempts: true } });
      return d?.status === 'SUCCEEDED' ? d : null;
    });
    expect(delivered.attempts.map((a) => a.outcome).sort()).toEqual(['HTTP_ERROR', 'SUCCESS']);
    expect(target.requests).toHaveLength(2);
    expect(await ctx.deps.prisma.outboxMessage.count({ where: { status: 'PENDING' } })).toBe(0);

    const checks = await ctx.deps.prisma.policyCheck.findMany({ orderBy: { id: 'asc' } });
    expect(checks.map((c) => `${c.trigger}:${c.outcome}`)).toEqual(['ENROLLMENT:BASELINE', 'MANUAL:CHANGED']);
    expect(checks.every((c) => c.correlationId === 'e2e-test')).toBe(true);

    const health = await worker.health();
    expect(health.status).toBe('ok');
    await waitFor(async () => (await readHeartbeats(ctx.deps.redis, ctx.deps.config.queuePrefix)).length > 0);
  });

  it('the scheduler picks up due policies on its own', async () => {
    worker = await startWorker(ctx.deps, { healthPort: null });
    const { policy } = await enrollPolicy(ctx.deps, { carrierId: 'bluebird', externalPolicyId: 'BB-55120' }, 'sched-test');
    await waitFor(async () => (await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } })).currentVersion === 1);
    mutate(ctx, 'bluebird', 'BB-55120', { removeVehicleVin: '4T1B11HK5KU000301' });
    await ctx.deps.prisma.policy.update({ where: { id: policy.id }, data: { nextCheckAt: new Date(Date.now() - 1_000) } });

    const event = await waitFor(() => ctx.deps.prisma.policyEvent.findFirst({ where: { eventType: 'VEHICLE_REMOVED' } }));
    expect(event.policyVersion).toBe(2);
    const checks = await ctx.deps.prisma.policyCheck.findMany({ where: { policyId: policy.id }, orderBy: { id: 'asc' } });
    expect(checks.map((c) => c.trigger)).toEqual(['ENROLLMENT', 'SCHEDULED']);
  });

  it('graceful stop waits for the in-flight delivery to finish before returning', async () => {
    const delivery = await relayedCancellation();
    await ctx.deps.queues.deliveries.obliterate({ force: true });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    target.respond = async () => {
      await held; // receiver is mid-request when shutdown begins
      return 200;
    };

    worker = await startWorker(ctx.deps, { healthPort: null, loops: { scheduler: false, sweeper: false } });
    await ctx.deps.queues.deliveries.add('deliver', { deliveryId: delivery.id, trigger: 'AUTOMATIC', correlationId: 'stop-test' }, { jobId: `${delivery.id}-a1` });
    await waitFor(async () => target.requests.length === 1);

    const stopping = worker.stop();
    worker = undefined;
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(false); // still draining the active job
    release();
    await stopping;

    const final = await ctx.deps.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(final).toMatchObject({ status: 'SUCCEEDED', lockedUntil: null, attemptCount: 1 });
  });
});
