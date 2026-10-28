import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DestinationPolicy } from '../../src/webhooks/ssrf.js';
import { relayOutbox } from '../../src/outbox/relay.js';
import { processDelivery, requestRedelivery } from '../../src/webhooks/delivery-service.js';
import { HEADERS, verifySignature } from '../../src/webhooks/signing.js';
import { createSubscription } from '../../src/webhooks/subscriptions.js';
import {
  check,
  createTestContext,
  enrollWithBaseline,
  mutate,
  resetState,
  startWebhookTarget,
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

/** Subscription → cancellation → relay. Returns the single POLICY_CANCELLED delivery. */
async function pendingCancellationDelivery(url = `${target.url}/hook`) {
  const { subscription, secret } = await createSubscription(ctx.deps, { url, eventTypes: ['POLICY_CANCELLED'], carrierIds: [] });
  const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
  mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
  const result = await check(ctx.deps, policy.id);
  await relayOutbox(ctx.deps);
  const delivery = await ctx.deps.prisma.webhookDelivery.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
  return { delivery, secret, subscription, eventId: result.events[0]!.id };
}

const deliver = (id: string, trigger: 'AUTOMATIC' | 'MANUAL' = 'AUTOMATIC') => processDelivery(ctx.deps, id, { trigger });
const load = (id: string) => ctx.deps.prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: { attemptNumber: 'asc' } } } });
const makeDue = (id: string) => ctx.deps.prisma.webhookDelivery.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });

describe('successful delivery', () => {
  it('POSTs a signed, timestamped payload that a consumer can verify', async () => {
    const { delivery, secret, eventId } = await pendingCancellationDelivery();
    expect(await deliver(delivery.id)).toMatchObject({ status: 'SUCCEEDED', attemptNumber: 1 });

    expect(target.requests).toHaveLength(1);
    const req = target.requests[0]!;
    expect(req.headers[HEADERS.eventId]).toBe(eventId);
    expect(req.headers[HEADERS.eventType]).toBe('POLICY_CANCELLED');
    expect(req.headers[HEADERS.deliveryId]).toBe(delivery.id);
    expect(req.headers[HEADERS.attempt]).toBe('1');
    expect(req.headers['content-type']).toBe('application/json');

    const verification = verifySignature({
      body: req.body,
      signatureHeader: req.headers[HEADERS.signature] as string,
      timestampHeader: req.headers[HEADERS.timestamp] as string,
      secrets: secret,
    });
    expect(verification.ok).toBe(true);

    const payload = JSON.parse(req.body);
    expect(Object.keys(payload)).toEqual([
      'eventId', 'eventType', 'schemaVersion', 'occurredAt', 'policyId', 'carrierId', 'externalPolicyId', 'policyVersion', 'previousVersion', 'data',
    ]);
    expect(payload).toMatchObject({ eventId, eventType: 'POLICY_CANCELLED', schemaVersion: '1.0', carrierId: 'acme', policyVersion: 2 });
    // No policyholder PII in webhook bodies.
    expect(req.body).not.toMatch(/Rivera|example\.com|555/);

    const stored = await load(delivery.id);
    expect(stored).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1, lastResponseStatus: 200, lockedUntil: null });
    expect(stored.attempts).toHaveLength(1);
    expect(stored.attempts[0]).toMatchObject({ outcome: 'SUCCESS', responseStatus: 200, trigger: 'AUTOMATIC', destinationHost: new URL(target.url).host });
  });

  it('a delivery that already succeeded is not sent again by a stray job', async () => {
    const { delivery } = await pendingCancellationDelivery();
    await deliver(delivery.id);
    expect(await deliver(delivery.id)).toEqual({ status: 'SKIPPED', reason: 'NOT_CLAIMABLE' });
    expect(target.requests).toHaveLength(1);
  });
});

describe('failures and retries', () => {
  it('a 503 schedules a retry with backoff and records the attempt', async () => {
    target.respond = () => 503;
    const { delivery } = await pendingCancellationDelivery();
    const before = Date.now();
    const result = await deliver(delivery.id);
    expect(result.status).toBe('RETRY_SCHEDULED');

    const stored = await load(delivery.id);
    expect(stored).toMatchObject({ status: 'RETRY_SCHEDULED', attemptCount: 1, lastResponseStatus: 503, lastError: 'Receiver responded with HTTP 503' });
    // base 40 ms, equal jitter → [20, 40] ms after completion
    const delay = stored.nextAttemptAt.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(15);
    expect(delay).toBeLessThan(1_000);
    expect(stored.attempts[0]).toMatchObject({ outcome: 'HTTP_ERROR', responseStatus: 503 });

    const jobs = await ctx.deps.queues.deliveries.getJobs(['delayed', 'waiting']);
    expect(jobs.map((j) => j.id)).toContain(`${delivery.id}-a2`);
  });

  it('a delivery is not attempted again before its backoff elapses', async () => {
    target.respond = () => 503;
    const { delivery } = await pendingCancellationDelivery();
    await deliver(delivery.id);
    await ctx.deps.prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(Date.now() + 60_000) } });
    expect(await deliver(delivery.id)).toEqual({ status: 'SKIPPED', reason: 'NOT_CLAIMABLE' });
    expect(target.requests).toHaveLength(1);
  });

  it('retries until the receiver recovers, keeping the same eventId and body', async () => {
    target.respond = (_req, i) => (i < 2 ? 500 : 200);
    const { delivery } = await pendingCancellationDelivery();
    expect((await deliver(delivery.id)).status).toBe('RETRY_SCHEDULED');
    await makeDue(delivery.id);
    expect((await deliver(delivery.id)).status).toBe('RETRY_SCHEDULED');
    await makeDue(delivery.id);
    expect(await deliver(delivery.id)).toMatchObject({ status: 'SUCCEEDED', attemptNumber: 3 });

    const stored = await load(delivery.id);
    expect(stored.attempts.map((a) => `${a.attemptNumber}:${a.outcome}:${a.responseStatus}`)).toEqual(['1:HTTP_ERROR:500', '2:HTTP_ERROR:500', '3:SUCCESS:200']);
    expect(new Set(target.requests.map((r) => r.body)).size).toBe(1);
    expect(target.requests.map((r) => r.headers[HEADERS.attempt])).toEqual(['1', '2', '3']);
  });

  it('gives up after maxAttempts (bounded retries)', async () => {
    target.respond = () => 502;
    const { delivery } = await pendingCancellationDelivery();
    for (let i = 0; i < 3; i++) {
      await makeDue(delivery.id);
      await deliver(delivery.id);
    }
    const stored = await load(delivery.id);
    expect(stored).toMatchObject({ status: 'FAILED', attemptCount: 3 });
    expect(stored.failedAt).not.toBeNull();
    await makeDue(delivery.id);
    expect((await deliver(delivery.id)).status).toBe('SKIPPED');
    expect(target.requests).toHaveLength(3);
  });

  it('a permanent client error (400) fails immediately without retrying', async () => {
    target.respond = () => 400;
    const { delivery } = await pendingCancellationDelivery();
    expect((await deliver(delivery.id)).status).toBe('FAILED');
    expect((await load(delivery.id)).attemptCount).toBe(1);
  });

  it('a receiver that never answers times out and is retried', async () => {
    target.respond = () => 'hang';
    const { delivery } = await pendingCancellationDelivery();
    const started = Date.now();
    expect((await deliver(delivery.id)).status).toBe('RETRY_SCHEDULED');
    expect(Date.now() - started).toBeLessThan(2_000); // WEBHOOK_TIMEOUT_MS = 400
    expect((await load(delivery.id)).attempts[0]).toMatchObject({ outcome: 'TIMEOUT', responseStatus: null });
  });

  it('a refused connection is a retryable network error', async () => {
    const { delivery } = await pendingCancellationDelivery();
    await target.close(); // receiver goes away: nothing listens on that port any more
    expect((await deliver(delivery.id)).status).toBe('RETRY_SCHEDULED');
    expect((await load(delivery.id)).attempts[0]).toMatchObject({ outcome: 'NETWORK_ERROR' });
  });
});

describe('duplicate delivery protection', () => {
  it('concurrent jobs for one delivery result in exactly one HTTP request', async () => {
    target.respond = () => 200;
    const { delivery } = await pendingCancellationDelivery();
    const results = await Promise.all(Array.from({ length: 8 }, () => deliver(delivery.id)));
    expect(results.filter((r) => r.status === 'SUCCEEDED')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'SKIPPED')).toHaveLength(7);
    expect(target.requests).toHaveLength(1);
    expect((await load(delivery.id)).attempts).toHaveLength(1);
  });

  it('manual redelivery re-sends the same event (consumers dedupe on eventId)', async () => {
    const { delivery, eventId } = await pendingCancellationDelivery();
    await deliver(delivery.id);
    const updated = await requestRedelivery(ctx.deps, delivery.id, 'manual-test');
    expect(updated).toMatchObject({ status: 'PENDING', manualRetryCount: 1, maxAttempts: 1 + 3 });
    expect(await deliver(delivery.id, 'MANUAL')).toMatchObject({ status: 'SUCCEEDED', attemptNumber: 2 });

    expect(target.requests.map((r) => r.headers[HEADERS.eventId])).toEqual([eventId, eventId]);
    expect(target.requests[0]!.body).toBe(target.requests[1]!.body);
    expect((await load(delivery.id)).attempts.map((a) => a.trigger)).toEqual(['AUTOMATIC', 'MANUAL']);
    const jobs = await ctx.deps.queues.deliveries.getJobs(['waiting']);
    expect(jobs.map((j) => j.id)).toContain(`${delivery.id}-m1`);
  });

  it('manual redelivery is refused while a delivery is in flight or its subscription is inactive', async () => {
    const { delivery, subscription } = await pendingCancellationDelivery();
    await expect(requestRedelivery(ctx.deps, delivery.id, 'x')).rejects.toMatchObject({ code: 'DELIVERY_IN_FLIGHT', status: 409 });
    await deliver(delivery.id);
    await ctx.deps.prisma.webhookSubscription.update({ where: { id: subscription.id }, data: { status: 'INACTIVE' } });
    await expect(requestRedelivery(ctx.deps, delivery.id, 'x')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
  });

  it('deliveries for a deactivated subscription are cancelled, not sent', async () => {
    const { delivery, subscription } = await pendingCancellationDelivery();
    await ctx.deps.prisma.webhookSubscription.update({ where: { id: subscription.id }, data: { status: 'INACTIVE' } });
    expect(await deliver(delivery.id)).toEqual({ status: 'CANCELLED' });
    expect(target.requests).toHaveLength(0);
    expect(await load(delivery.id)).toMatchObject({ status: 'CANCELLED', attemptCount: 0 });
  });
});

describe('SSRF protection at delivery time', () => {
  it('re-validates the URL on every attempt (allowlist removed after the subscription was created)', async () => {
    // Created while 127.0.0.1 was allowlisted; the policy has since been tightened.
    const { delivery } = await pendingCancellationDelivery();
    const strict = { ...ctx.deps, destinations: new DestinationPolicy({ requireHttps: false, allowedHosts: [] }) };
    expect((await processDelivery(strict, delivery.id, { trigger: 'AUTOMATIC' })).status).toBe('FAILED');
    expect(target.requests).toHaveLength(0);
    expect((await load(delivery.id)).attempts[0]).toMatchObject({ outcome: 'BLOCKED_DESTINATION' });
  });

  it('the connect-time guard blocks a hostname that only resolves privately at send time', async () => {
    const { delivery } = await pendingCancellationDelivery();
    await ctx.deps.prisma.webhookSubscription.updateMany({ data: { url: `http://rebind.example.test:${new URL(target.url).port}/hook` } });
    const rebinding = new DestinationPolicy({
      requireHttps: false,
      allowedHosts: [],
      lookup: ((_h: string, _o: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) =>
        cb(null, [{ address: '127.0.0.1', family: 4 }])) as never,
    });
    const result = await processDelivery({ ...ctx.deps, destinations: rebinding }, delivery.id, { trigger: 'AUTOMATIC' });
    expect(result.status).toBe('FAILED');
    expect(target.requests).toHaveLength(0);
    expect((await load(delivery.id)).attempts[0]).toMatchObject({ outcome: 'BLOCKED_DESTINATION', destinationHost: expect.stringContaining('rebind.example.test') });
  });
});
