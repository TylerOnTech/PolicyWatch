import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkPolicy } from '../../src/monitoring/check-policy.js';
import { scheduleDueChecks } from '../../src/monitoring/scheduler.js';
import { check, createTestContext, enrollWithBaseline, insertPolicy, mutate, resetState, type TestContext } from './helpers.js';

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

const countRows = async () => {
  const p = ctx.deps.prisma;
  const [snapshots, events, outbox, checks] = await Promise.all([
    p.policySnapshot.count(),
    p.policyEvent.count(),
    p.outboxMessage.count(),
    p.policyCheck.count(),
  ]);
  return { snapshots, events, outbox, checks };
};

describe('baseline and change detection over real carrier HTTP calls', () => {
  it.each([
    ['acme', 'ACM-AUTO-100234'],
    ['bluebird', 'BB-55120'],
    ['cardinal', 'CC-7781-2026'],
  ])('%s: first check stores version 1 and emits no events', async (carrierId, number) => {
    const policy = await insertPolicy(ctx.deps, carrierId, number);
    const result = await check(ctx.deps, policy.id);
    expect(result).toMatchObject({ outcome: 'BASELINE', snapshotVersion: 1, events: [] });

    const stored = await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(stored).toMatchObject({ status: 'ACTIVE', currentVersion: 1, lastCheckOutcome: 'BASELINE', consecutiveFailures: 0 });
    expect(await countRows()).toMatchObject({ snapshots: 1, events: 0, outbox: 0, checks: 1 });
  });

  it('a confirmed cancellation produces one POLICY_CANCELLED event, a new snapshot and an outbox row', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });

    const result = await check(ctx.deps, policy.id);
    expect(result.outcome).toBe('CHANGED');
    expect(result.events.map((e) => e.eventType)).toEqual(['POLICY_CANCELLED']);

    const event = await ctx.deps.prisma.policyEvent.findUniqueOrThrow({ where: { id: result.events[0]!.id }, include: { outbox: true } });
    expect(event).toMatchObject({
      policyVersion: 2,
      previousVersion: 1,
      dedupeKey: `${policy.id}:v2:POLICY_CANCELLED:`,
      correlationId: 'test-correlation-id',
      data: { previousStatus: 'ACTIVE', currentStatus: 'CANCELLED' },
    });
    expect(event.outbox).toMatchObject({ status: 'PENDING', topic: 'policy.event' });
    expect((await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } })).status).toBe('CANCELLED');
  });

  it('renewal with a new premium produces POLICY_RENEWED and PREMIUM_CHANGED', async () => {
    const policy = await enrollWithBaseline(ctx, 'cardinal', 'CC-7902-2026'); // seeded as EXPIRED
    mutate(ctx, 'cardinal', 'CC-7902-2026', { renew: { termMonths: 6, premiumCents: 61_200 } });
    const result = await check(ctx.deps, policy.id);
    expect(result.events.map((e) => e.eventType)).toEqual(['POLICY_RENEWED', 'PREMIUM_CHANGED']);
    const stored = await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(stored.effectiveDate?.toISOString().slice(0, 10)).toBe('2026-07-10');
    expect(stored.expirationDate?.toISOString().slice(0, 10)).toBe('2027-01-10');
  });

  it('vehicle and coverage changes are reported once each', async () => {
    const policy = await enrollWithBaseline(ctx, 'bluebird', 'BB-55120');
    mutate(ctx, 'bluebird', 'BB-55120', {
      addVehicle: { vin: '1FTFW1E50NF000999', year: 2022, make: 'Ford', model: 'F-150' },
      setCoverage: { type: 'BODILY_INJURY_LIABILITY', perPersonCents: 10_000_000, perOccurrenceCents: 30_000_000 },
    });
    const result = await check(ctx.deps, policy.id);
    expect(result.events.map((e) => e.eventType)).toEqual(['COVERAGE_CHANGED', 'VEHICLE_ADDED']);
  });
});

describe('false-positive resistance', () => {
  it('cosmetic formatting differences between responses do not create snapshots or events', async () => {
    const policy = await enrollWithBaseline(ctx, 'cardinal', 'CC-7781-2026');
    ctx.sim.store.noise = true; // alternate case/whitespace/money/date/phone formats and array order
    for (let i = 0; i < 4; i++) {
      expect((await check(ctx.deps, policy.id)).outcome).toBe('UNCHANGED');
    }
    expect(await countRows()).toMatchObject({ snapshots: 1, events: 0, outbox: 0, checks: 5 });
  });

  it('a change with no v1 event type creates a new version but no events', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100871');
    mutate(ctx, 'acme', 'ACM-AUTO-100871', { insuredEmail: 'priya.n@example.org' });
    expect(await check(ctx.deps, policy.id)).toMatchObject({ outcome: 'CHANGED', snapshotVersion: 2, events: [] });
  });
});

describe('unavailable carrier data is never mistaken for a policy change', () => {
  it.each([
    ['acme', 'ACM-AUTO-100234', 'http_503', 'CARRIER_UNAVAILABLE', 503],
    ['acme', 'ACM-AUTO-100234', 'http_500', 'CARRIER_UNAVAILABLE', 500],
    ['acme', 'ACM-AUTO-100234', 'timeout', 'CARRIER_TIMEOUT', null],
    ['acme', 'ACM-AUTO-100234', 'rate_limited', 'CARRIER_RATE_LIMITED', 429],
    ['acme', 'ACM-AUTO-100234', 'not_found', 'POLICY_NOT_FOUND', 404],
    ['acme', 'ACM-AUTO-100234', 'auth_error', 'CARRIER_AUTH_FAILED', 401],
    ['acme', 'ACM-AUTO-100234', 'malformed', 'INVALID_CARRIER_RESPONSE', 200],
    ['bluebird', 'BB-55120', 'data_unavailable', 'CARRIER_DATA_UNAVAILABLE', 200],
    ['bluebird', 'BB-55120', 'malformed', 'INVALID_CARRIER_RESPONSE', 200],
    ['cardinal', 'CC-7781-2026', 'data_unavailable', 'CARRIER_DATA_UNAVAILABLE', 200],
    ['cardinal', 'CC-7781-2026', 'not_found', 'POLICY_NOT_FOUND', 200],
    ['cardinal', 'CC-7781-2026', 'malformed', 'INVALID_CARRIER_RESPONSE', 200],
  ] as const)('%s %s → %s', async (carrierId, number, mode, category, httpStatus) => {
    const policy = await enrollWithBaseline(ctx, carrierId, number);
    ctx.sim.store.setFault(carrierId, { mode, remaining: null });

    const result = await check(ctx.deps, policy.id);
    expect(result).toMatchObject({ outcome: 'FAILED', failureCategory: category, events: [] });

    const stored = await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(stored).toMatchObject({ status: 'ACTIVE', currentVersion: 1, lastCheckOutcome: 'FAILED', lastFailureCategory: category, consecutiveFailures: 1 });
    const failed = await ctx.deps.prisma.policyCheck.findUniqueOrThrow({ where: { id: result.checkId } });
    expect(failed.httpStatus).toBe(httpStatus);
    expect(await countRows()).toMatchObject({ snapshots: 1, events: 0, outbox: 0 });
  });

  it('backs off after repeated failures and recovers cleanly', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    ctx.sim.store.setFault('acme', { mode: 'http_503', remaining: 3 });
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = Date.now();
      await check(ctx.deps, policy.id);
      const p = await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
      delays.push(Math.round((p.nextCheckAt.getTime() - before) / 1000));
    }
    // Retry-After: 30 from the carrier dominates the first step; then 60 s, 120 s (+ ≤10% jitter).
    expect(delays[0]).toBeGreaterThanOrEqual(30);
    expect(delays[1]).toBeGreaterThanOrEqual(60);
    expect(delays[2]).toBeGreaterThanOrEqual(120);
    expect((await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } })).consecutiveFailures).toBe(3);

    // Carrier healthy again, and the policy really was cancelled meanwhile: now it is detected.
    mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
    const recovered = await check(ctx.deps, policy.id);
    expect(recovered.events.map((e) => e.eventType)).toEqual(['POLICY_CANCELLED']);
    const p = await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(p).toMatchObject({ consecutiveFailures: 0, lastFailureCategory: null, lastCheckOutcome: 'CHANGED' });
  });

  it('a carrier answering with a different policy is rejected', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
    // Simulate a carrier-side mix-up: the body describes a different policy number.
    const adapter = ctx.deps.carriers.get('acme')!;
    const realFetch = adapter.fetchPolicy.bind(adapter);
    adapter.fetchPolicy = async (id, c) => {
      const res = await realFetch(id, c);
      return { ...res, policy: { ...res.policy, externalPolicyId: 'ACM-AUTO-999999' } };
    };
    try {
      expect(await check(ctx.deps, policy.id)).toMatchObject({ outcome: 'FAILED', failureCategory: 'INVALID_CARRIER_RESPONSE' });
      expect(await ctx.deps.prisma.policyEvent.count()).toBe(0);
    } finally {
      adapter.fetchPolicy = realFetch;
    }
  });
});

describe('idempotent event generation', () => {
  it('re-checking after a change does not emit the event again', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
    await check(ctx.deps, policy.id);
    expect((await check(ctx.deps, policy.id)).outcome).toBe('UNCHANGED');
    expect((await check(ctx.deps, policy.id)).outcome).toBe('UNCHANGED');
    expect(await ctx.deps.prisma.policyEvent.count({ where: { eventType: 'POLICY_CANCELLED' } })).toBe(1);
  });

  it('concurrent checks of the same policy (e.g. scheduled + manual, two workers) commit exactly one change', async () => {
    const policy = await enrollWithBaseline(ctx, 'bluebird', 'BB-55120');
    mutate(ctx, 'bluebird', 'BB-55120', { status: 'CANCELLED' });
    const results = await Promise.all(Array.from({ length: 6 }, () => check(ctx.deps, policy.id)));

    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes.filter((o) => o === 'CHANGED')).toHaveLength(1);
    expect(outcomes.every((o) => ['CHANGED', 'UNCHANGED', 'STALE_DISCARDED'].includes(o))).toBe(true);
    expect(await countRows()).toMatchObject({ snapshots: 2, events: 1, outbox: 1, checks: 7 });
  });

  it('a cancel → reinstate → cancel sequence produces three distinct events', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    for (const status of ['CANCELLED', 'ACTIVE', 'CANCELLED'] as const) {
      mutate(ctx, 'acme', 'ACM-AUTO-100234', { status });
      await check(ctx.deps, policy.id);
    }
    const events = await ctx.deps.prisma.policyEvent.findMany({ orderBy: { policyVersion: 'asc' } });
    expect(events.map((e) => `${e.policyVersion}:${e.eventType}`)).toEqual(['2:POLICY_CANCELLED', '3:POLICY_REINSTATED', '4:POLICY_CANCELLED']);
  });

  it('a stale response that lost a race is discarded instead of rolling state back', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    const adapter = ctx.deps.carriers.get('acme')!;
    const realFetch = adapter.fetchPolicy.bind(adapter);
    // Slow request A fetches the ACTIVE state, then stalls; meanwhile B observes the cancellation.
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    let calls = 0;
    adapter.fetchPolicy = async (id, c) => {
      const res = await realFetch(id, c);
      if (++calls === 1) await gate;
      return res;
    };
    try {
      const slow = checkPolicy(ctx.deps, policy.id, { trigger: 'SCHEDULED' });
      await new Promise((r) => setTimeout(r, 50));
      mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
      const fast = await check(ctx.deps, policy.id);
      expect(fast.events.map((e) => e.eventType)).toEqual(['POLICY_CANCELLED']);
      releaseA();
      expect((await slow).outcome).toBe('STALE_DISCARDED');
    } finally {
      adapter.fetchPolicy = realFetch;
    }
    const stored = await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(stored).toMatchObject({ status: 'CANCELLED', currentVersion: 2 });
    expect(await ctx.deps.prisma.policyEvent.count()).toBe(1);
  });
});

describe('policy history persistence', () => {
  it('keeps every version with its content hash and the events it produced', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    mutate(ctx, 'acme', 'ACM-AUTO-100234', { premiumCents: 70_000 });
    await check(ctx.deps, policy.id);
    mutate(ctx, 'acme', 'ACM-AUTO-100234', { removeVehicleVin: '1HGCV1F30MA000101' });
    await check(ctx.deps, policy.id);

    const snapshots = await ctx.deps.prisma.policySnapshot.findMany({ where: { policyId: policy.id }, orderBy: { version: 'asc' } });
    expect(snapshots.map((s) => s.version)).toEqual([1, 2, 3]);
    expect(new Set(snapshots.map((s) => s.contentHash)).size).toBe(3);
    expect((snapshots[0]!.data as { premium: { amountCents: number } }).premium.amountCents).toBe(64_250);
    expect((snapshots[1]!.data as { premium: { amountCents: number } }).premium.amountCents).toBe(70_000);
    expect((snapshots[2]!.data as { vehicles: unknown[] }).vehicles).toEqual([]);

    const events = await ctx.deps.prisma.policyEvent.findMany({ where: { policyId: policy.id }, orderBy: { id: 'asc' } });
    expect(events.map((e) => `${e.policyVersion}:${e.eventType}`)).toEqual(['2:PREMIUM_CHANGED', '3:VEHICLE_REMOVED']);
  });
});

describe('scheduler', () => {
  it('enqueues each due policy exactly once, even with concurrent schedulers', async () => {
    const due = await Promise.all([
      insertPolicy(ctx.deps, 'acme', 'ACM-AUTO-100234'),
      insertPolicy(ctx.deps, 'bluebird', 'BB-55120'),
      insertPolicy(ctx.deps, 'cardinal', 'CC-7781-2026'),
    ]);
    const notDue = await insertPolicy(ctx.deps, 'acme', 'ACM-AUTO-100871');
    const disabled = await insertPolicy(ctx.deps, 'bluebird', 'BB-55388');
    await ctx.deps.prisma.policy.updateMany({ where: { id: { in: [...due.map((p) => p.id), disabled.id] } }, data: { nextCheckAt: new Date(Date.now() - 1000) } });
    await ctx.deps.prisma.policy.update({ where: { id: disabled.id }, data: { monitoringEnabled: false } });

    const counts = await Promise.all([scheduleDueChecks(ctx.deps), scheduleDueChecks(ctx.deps), scheduleDueChecks(ctx.deps)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);

    const jobs = await ctx.deps.queues.checks.getJobs(['waiting', 'delayed']);
    expect(jobs.map((j) => j.data.policyId).sort()).toEqual(due.map((p) => p.id).sort());
    expect(jobs.every((j) => j.data.trigger === 'SCHEDULED')).toBe(true);

    // Leased: the next tick finds nothing due.
    expect(await scheduleDueChecks(ctx.deps)).toBe(0);
    const leased = await ctx.deps.prisma.policy.findUniqueOrThrow({ where: { id: due[0]!.id } });
    expect(leased.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 200_000);
    expect(jobs.some((j) => j.data.policyId === notDue.id)).toBe(false);
  });
});
