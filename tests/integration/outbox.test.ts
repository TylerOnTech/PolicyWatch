import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../../src/lib/crypto.js';
import { newId } from '../../src/lib/ids.js';
import { relayOutbox } from '../../src/outbox/relay.js';
import { check, createTestContext, enrollWithBaseline, mutate, resetState, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

async function subscribe(eventTypes: string[], carrierIds: string[] = [], status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') {
  return ctx.deps.prisma.webhookSubscription.create({
    data: {
      id: newId('sub'),
      url: 'http://127.0.0.1:9/never-called',
      eventTypes,
      carrierIds,
      status,
      secretCiphertext: encryptSecret('whsec_test', ctx.deps.config.secretEncryptionKey),
      secretHint: 'test',
    },
  });
}

async function cancellationEvent() {
  const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
  mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED', premiumCents: 0 });
  const result = await check(ctx.deps, policy.id);
  return { policy, result };
}

describe('transactional outbox', () => {
  it('commits events and their outbox rows atomically with the snapshot — or not at all', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    // Plant a row that collides with the dedupe key the next check will generate, forcing the
    // transaction to fail *after* the snapshot and first event inserts have been issued.
    await ctx.deps.prisma.policyEvent.create({
      data: {
        id: newId('evt'),
        policyId: policy.id,
        carrierId: 'acme',
        externalPolicyId: policy.externalPolicyId,
        eventType: 'POLICY_CANCELLED',
        schemaVersion: '1.0',
        policyVersion: 99,
        previousVersion: 98,
        dedupeKey: `${policy.id}:v2:PREMIUM_CHANGED:`,
        data: {},
        occurredAt: new Date(),
      },
    });
    mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED', premiumCents: 0 });

    await expect(check(ctx.deps, policy.id)).rejects.toThrow();

    // Nothing from the failed transaction is visible: no version 2, no events, no outbox rows.
    expect(await ctx.deps.prisma.policySnapshot.count({ where: { policyId: policy.id } })).toBe(1);
    expect(await ctx.deps.prisma.policyEvent.count()).toBe(1); // only the planted row
    expect(await ctx.deps.prisma.outboxMessage.count()).toBe(0);
    const stored = await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(stored).toMatchObject({ status: 'ACTIVE', currentVersion: 1 });
  });

  it('every committed event has exactly one outbox row', async () => {
    const { result } = await cancellationEvent();
    expect(result.events).toHaveLength(2);
    const outbox = await ctx.deps.prisma.outboxMessage.findMany();
    expect(outbox.map((o) => o.eventId).sort()).toEqual(result.events.map((e) => e.id).sort());
  });
});

describe('outbox relay', () => {
  it('fans out to matching active subscriptions only, and marks messages processed', async () => {
    const all = await subscribe(['*']);
    const cancelOnly = await subscribe(['POLICY_CANCELLED']);
    const otherCarrier = await subscribe(['*'], ['bluebird']);
    const inactive = await subscribe(['*'], [], 'INACTIVE');
    const { result } = await cancellationEvent();

    const relay = await relayOutbox(ctx.deps);
    expect(relay).toMatchObject({ messages: 2, deliveriesCreated: 3 });

    const deliveries = await ctx.deps.prisma.webhookDelivery.findMany({ include: { event: true } });
    const bySub = (id: string) => deliveries.filter((d) => d.subscriptionId === id).map((d) => d.event.eventType).sort();
    expect(bySub(all.id)).toEqual(['POLICY_CANCELLED', 'PREMIUM_CHANGED']);
    expect(bySub(cancelOnly.id)).toEqual(['POLICY_CANCELLED']);
    expect(bySub(otherCarrier.id)).toEqual([]);
    expect(bySub(inactive.id)).toEqual([]);
    expect(deliveries.every((d) => d.status === 'PENDING' && d.maxAttempts === 3)).toBe(true);

    const outbox = await ctx.deps.prisma.outboxMessage.findMany();
    expect(outbox.every((o) => o.status === 'PROCESSED' && o.processedAt !== null)).toBe(true);

    const jobs = await ctx.deps.queues.deliveries.getJobs(['waiting']);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.id?.endsWith('-a1'))).toBe(true);
    // Correlation ID from the originating check is propagated to delivery jobs.
    expect(jobs.every((j) => j.data.correlationId === 'test-correlation-id')).toBe(true);
    expect(result.events).toHaveLength(2);
  });

  it('is idempotent: replaying already-relayed messages never duplicates deliveries', async () => {
    await subscribe(['*']);
    await cancellationEvent();
    await relayOutbox(ctx.deps);
    // Simulate "message processed but marked pending again" (e.g. restored backup, operator replay).
    await ctx.deps.prisma.outboxMessage.updateMany({ data: { status: 'PENDING' } });
    const replay = await relayOutbox(ctx.deps);
    expect(replay).toMatchObject({ messages: 2, deliveriesCreated: 0 });
    expect(await ctx.deps.prisma.webhookDelivery.count()).toBe(2);
  });

  it('concurrent relays partition the work without duplicates (SKIP LOCKED)', async () => {
    await subscribe(['*']);
    for (const number of ['ACM-AUTO-100234', 'ACM-AUTO-100871']) {
      const policy = await enrollWithBaseline(ctx, 'acme', number);
      mutate(ctx, 'acme', number, { status: 'CANCELLED', premiumCents: 1 });
      await check(ctx.deps, policy.id);
    }
    const results = await Promise.all([relayOutbox(ctx.deps), relayOutbox(ctx.deps), relayOutbox(ctx.deps)]);
    expect(results.reduce((n, r) => n + r.messages, 0)).toBe(4);
    expect(await ctx.deps.prisma.webhookDelivery.count()).toBe(4);
    expect(await ctx.deps.prisma.outboxMessage.count({ where: { status: 'PENDING' } })).toBe(0);
  });

  it('subscriptions created after an event do not receive it retroactively', async () => {
    await cancellationEvent();
    await relayOutbox(ctx.deps);
    await subscribe(['*']);
    expect((await relayOutbox(ctx.deps)).messages).toBe(0);
    expect(await ctx.deps.prisma.webhookDelivery.count()).toBe(0);
  });
});
