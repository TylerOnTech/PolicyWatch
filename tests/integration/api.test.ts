import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp, type ApiApp } from '../../src/api/app.js';
import { loadOpenApiSpec } from '../../src/api/openapi.js';
import { encodeCursor } from '../../src/api/validation.js';
import { newId } from '../../src/lib/ids.js';
import { relayOutbox } from '../../src/outbox/relay.js';
import { startWorker } from '../../src/worker/worker.js';
import { ADMIN_KEY, READONLY_KEY } from './env.js';
import { check, createTestContext, enrollWithBaseline, mutate, resetState, startWebhookTarget, type TestContext } from './helpers.js';

let ctx: TestContext;
let api: ApiApp;
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };
const reader = { Authorization: `Bearer ${READONLY_KEY}` };

beforeAll(async () => {
  ctx = await createTestContext();
  api = createApiApp(ctx.deps);
});
afterAll(async () => {
  await api.close();
  await ctx.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

const http = () => request(api.app);

describe('authentication and authorization', () => {
  it('public endpoints need no key', async () => {
    await http().get('/health/live').expect(200, { status: 'ok' });
    const health = await http().get('/health').expect(200);
    expect(health.body.checks.database.status).toBe('up');
    expect(health.body.checks.redis.status).toBe('up');
    await http().get('/openapi.json').expect(200);
  });

  it('rejects missing and invalid keys with 401 and a WWW-Authenticate challenge', async () => {
    const missing = await http().get('/policies').expect(401);
    expect(missing.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');
    await http().get('/policies').set({ Authorization: 'Bearer wrong-key-that-is-long-enough-000000' }).expect(401);
    await http().get('/policies').set({ Authorization: `Basic ${ADMIN_KEY}` }).expect(401);
  });

  it('the read-only key can read but not write', async () => {
    await http().get('/policies').set(reader).expect(200);
    await http().get('/metrics').set(reader).expect(200);
    const res = await http().post('/subscriptions').set(reader).send({ url: 'https://hooks.example.com/x', eventTypes: ['*'] }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    await http().post(`/policies/${newId('pol')}/check`).set(reader).expect(403);
  });

  it('echoes a well-formed X-Request-Id and includes it in error bodies', async () => {
    const res = await http().get('/policies').set('X-Request-Id', 'client-req-12345').expect(401);
    expect(res.headers['x-request-id']).toBe('client-req-12345');
    expect(res.body.error.requestId).toBe('client-req-12345');
    const minted = await http().get('/health/live').set('X-Request-Id', 'bad id with spaces');
    expect(minted.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('validation and error envelope', () => {
  it.each([
    ['/policies?limit=0', 'limit'],
    ['/policies?limit=101', 'limit'],
    ['/policies?status=LAPSED', 'status'],
    ['/events?eventType=POLICY_EXPLODED', 'eventType'],
    ['/events?since=yesterday', 'since'],
    ['/deliveries?status=DONE', 'status'],
  ])('GET %s → 400 VALIDATION_ERROR on %s', async (url, path) => {
    const res = await http().get(url).set(admin).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it('rejects a forged cursor', async () => {
    const res = await http().get('/policies?cursor=not-a-cursor').set(admin).expect(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });

  it('rejects malformed JSON and unknown fields', async () => {
    const bad = await http().post('/policies').set(admin).set('content-type', 'application/json').send('{"carrierId":').expect(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    const extra = await http().post('/policies').set(admin).send({ carrierId: 'acme', externalPolicyId: 'X-1', admin: true }).expect(400);
    expect(extra.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates enrollment input', async () => {
    const res = await http().post('/policies').set(admin).send({ carrierId: 'nationwide', externalPolicyId: '../../etc', checkIntervalSeconds: 0 }).expect(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['carrierId', 'externalPolicyId', 'checkIntervalSeconds']));
  });

  it('returns 404 for unknown or malformed resource IDs, and ROUTE_NOT_FOUND for unknown routes', async () => {
    expect((await http().get(`/policies/${newId('pol')}`).set(admin).expect(404)).body.error.code).toBe('RESOURCE_NOT_FOUND');
    await http().get('/policies/not-an-id').set(admin).expect(404);
    await http().get(`/events/${newId('pol')}`).set(admin).expect(404); // wrong prefix
    expect((await http().get('/nope').set(admin).expect(404)).body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('policies API', () => {
  it('enrolls, refuses duplicates, and returns the current snapshot', async () => {
    const created = await http().post('/policies').set(admin).send({ carrierId: 'acme', externalPolicyId: 'ACM-AUTO-100234', checkIntervalSeconds: 600 }).expect(201);
    expect(created.headers.location).toBe(`/policies/${created.body.id}`);
    expect(created.body).toMatchObject({ carrierId: 'acme', currentVersion: 0, monitoring: { enabled: true, checkIntervalSeconds: 600 } });

    const dup = await http().post('/policies').set(admin).send({ carrierId: 'acme', externalPolicyId: 'acm-auto-100234' }).expect(409);
    expect(dup.body.error).toMatchObject({ code: 'POLICY_ALREADY_ENROLLED', details: { policyId: created.body.id } });

    await check(ctx.deps, created.body.id);
    const detail = await http().get(`/policies/${created.body.id}`).set(reader).expect(200);
    expect(detail.body).toMatchObject({ status: 'ACTIVE', effectiveDate: '2026-05-01', premium: { amountCents: 64_250, currency: 'USD' } });
    expect(detail.body.current).toMatchObject({ schemaVersion: '1.0', externalPolicyId: 'ACM-AUTO-100234' });
  });

  it('history lists versions newest first with their events; checks are audited', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
    await check(ctx.deps, policy.id);
    ctx.sim.store.setFault('acme', { mode: 'http_503', remaining: 1 });
    await check(ctx.deps, policy.id);

    const history = await http().get(`/policies/${policy.id}/history`).set(admin).expect(200);
    expect(history.body.data.map((s: { version: number }) => s.version)).toEqual([2, 1]);
    expect(history.body.data[0].events.map((e: { eventType: string }) => e.eventType)).toEqual(['POLICY_CANCELLED']);
    expect(history.body.data[0].policy.status).toBe('CANCELLED');
    const lean = await http().get(`/policies/${policy.id}/history?includeData=false`).set(admin).expect(200);
    expect(lean.body.data[0].policy).toBeUndefined();

    const checks = await http().get(`/policies/${policy.id}/checks`).set(admin).expect(200);
    expect(checks.body.data.map((c: { outcome: string }) => c.outcome)).toEqual(['FAILED', 'CHANGED', 'BASELINE']);
    expect(checks.body.data[0]).toMatchObject({ failureCategory: 'CARRIER_UNAVAILABLE', httpStatus: 503 });
  });

  it('PATCH changes monitoring settings', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    const res = await http().patch(`/policies/${policy.id}`).set(admin).send({ monitoringEnabled: false, checkIntervalSeconds: 120 }).expect(200);
    expect(res.body.monitoring).toMatchObject({ enabled: false, checkIntervalSeconds: 120 });
    await http().patch(`/policies/${policy.id}`).set(admin).send({}).expect(400);
  });

  it('POST /policies/:id/check?wait=true returns the completed check and its events', async () => {
    const worker = await startWorker(ctx.deps, { healthPort: null, loops: { scheduler: false, sweeper: false } });
    try {
      const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
      mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
      const res = await http().post(`/policies/${policy.id}/check?wait=true`).set(admin).set('X-Request-Id', 'demo-check-0001').expect(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.check).toMatchObject({ outcome: 'CHANGED', trigger: 'MANUAL', correlationId: 'demo-check-0001', eventsGenerated: 1 });
      expect(res.body.events.map((e: { eventType: string }) => e.eventType)).toEqual(['POLICY_CANCELLED']);

      const queued = await http().post(`/policies/${policy.id}/check`).set(admin).expect(202);
      expect(queued.body).toMatchObject({ status: 'queued', policyId: policy.id });
    } finally {
      await worker.stop();
    }
  });
});

describe('pagination', () => {
  it('walks every page exactly once with keyset cursors', async () => {
    const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
    for (let i = 1; i <= 7; i++) {
      mutate(ctx, 'acme', 'ACM-AUTO-100234', { premiumCents: 64_250 + i * 100 });
      await check(ctx.deps, policy.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await http()
        .get(`/events?limit=3${cursor ? `&cursor=${cursor}` : ''}`)
        .set(admin)
        .expect(200);
      seen.push(...res.body.data.map((e: { id: string }) => e.id));
      cursor = res.body.pagination.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort().reverse()).toEqual(seen); // newest first

    const filtered = await http().get(`/events?eventType=PREMIUM_CHANGED&policyId=${policy.id}&limit=100`).set(admin).expect(200);
    expect(filtered.body.data).toHaveLength(7);
    // A cursor of the wrong kind for an endpoint is rejected.
    await http().get(`/policies/${policy.id}/history?cursor=${encodeCursor('abc')}`).set(admin).expect(400);
  });
});

describe('subscriptions API', () => {
  it('returns the signing secret once, never again', async () => {
    const created = await http()
      .post('/subscriptions')
      .set(admin)
      .send({ url: 'http://127.0.0.1:4100/webhooks', eventTypes: ['POLICY_CANCELLED', 'POLICY_CANCELLED'], description: 'retention' })
      .expect(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body.eventTypes).toEqual(['POLICY_CANCELLED']);
    expect(created.body.secretHint).toBe(`…${created.body.secret.slice(-4)}`);

    const fetched = await http().get(`/subscriptions/${created.body.id}`).set(admin).expect(200);
    expect(fetched.body.secret).toBeUndefined();
    const listed = await http().get('/subscriptions').set(admin).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
    const row = await ctx.deps.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.secretCiphertext).not.toContain(created.body.secret.slice(6));
  });

  it.each([
    ['http://10.0.0.5/hook', 'private or reserved'],
    ['https://169.254.169.254/latest/meta-data/iam/', 'private or reserved'],
    ['https://localhost/hook', 'not permitted'],
    ['https://postgres:5432/hook', 'fully-qualified'],
    ['file:///etc/passwd', 'scheme'],
    ['https://user:pw@hooks.example.com/x', 'credentials'],
  ])('rejects SSRF-prone URL %s', async (url, reason) => {
    const res = await http().post('/subscriptions').set(admin).send({ url, eventTypes: ['*'] }).expect(400);
    expect(res.body.error.code).toBe('INVALID_WEBHOOK_URL');
    expect(res.body.error.message).toContain(reason);
  });

  it('validates event types and carrier filters', async () => {
    const res = await http().post('/subscriptions').set(admin).send({ url: 'http://127.0.0.1:1/x', eventTypes: ['POLICY_EXPLODED'], carrierIds: ['nope'] }).expect(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['eventTypes.0', 'carrierIds.0']));
    await http().post('/subscriptions').set(admin).send({ url: 'http://127.0.0.1:1/x', eventTypes: [] }).expect(400);
  });

  it('deactivation cancels outstanding deliveries; delete is soft and hides the subscription', async () => {
    const target = await startWebhookTarget();
    try {
      const sub = (await http().post('/subscriptions').set(admin).send({ url: `${target.url}/hook`, eventTypes: ['*'] }).expect(201)).body;
      const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
      mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
      await check(ctx.deps, policy.id);
      await relayOutbox(ctx.deps);

      const off = await http().patch(`/subscriptions/${sub.id}`).set(admin).send({ active: false }).expect(200);
      expect(off.body.status).toBe('INACTIVE');
      const deliveries = await http().get(`/deliveries?subscriptionId=${sub.id}`).set(admin).expect(200);
      expect(deliveries.body.data.map((d: { status: string }) => d.status)).toEqual(['CANCELLED']);

      const delivery = deliveries.body.data[0];
      expect((await http().post(`/deliveries/${delivery.id}/retry`).set(admin).expect(409)).body.error.code).toBe('SUBSCRIPTION_INACTIVE');
      await http().patch(`/subscriptions/${sub.id}`).set(admin).send({ active: true }).expect(200);
      const retried = await http().post(`/deliveries/${delivery.id}/retry`).set(admin).expect(202);
      expect(retried.body).toMatchObject({ status: 'PENDING', manualRetryCount: 1 });
      expect((await http().post(`/deliveries/${delivery.id}/retry`).set(admin).expect(409)).body.error.code).toBe('DELIVERY_IN_FLIGHT');

      await http().delete(`/subscriptions/${sub.id}`).set(admin).expect(204);
      await http().delete(`/subscriptions/${sub.id}`).set(admin).expect(204); // idempotent
      const remaining = await http().get('/subscriptions').set(admin).expect(200);
      expect(remaining.body.data.map((s: { id: string }) => s.id)).not.toContain(sub.id);
      expect((await http().get(`/subscriptions/${sub.id}`).set(admin).expect(200)).body.status).toBe('DELETED');
      await http().patch(`/subscriptions/${sub.id}`).set(admin).send({ active: true }).expect(409);
    } finally {
      await target.close();
    }
  });
});

describe('events and deliveries API', () => {
  it('exposes the event, its deliveries, and the full attempt audit trail', async () => {
    const target = await startWebhookTarget();
    target.respond = (_r, i) => (i === 0 ? 500 : 200);
    try {
      await http().post('/subscriptions').set(admin).send({ url: `${target.url}/hook`, eventTypes: ['POLICY_CANCELLED'] }).expect(201);
      const policy = await enrollWithBaseline(ctx, 'acme', 'ACM-AUTO-100234');
      mutate(ctx, 'acme', 'ACM-AUTO-100234', { status: 'CANCELLED' });
      const { events } = await check(ctx.deps, policy.id);
      await relayOutbox(ctx.deps);
      const { processDelivery } = await import('../../src/webhooks/delivery-service.js');
      const d = await ctx.deps.prisma.webhookDelivery.findFirstOrThrow();
      await processDelivery(ctx.deps, d.id, { trigger: 'AUTOMATIC' });
      await ctx.deps.prisma.webhookDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await processDelivery(ctx.deps, d.id, { trigger: 'AUTOMATIC' });

      const event = await http().get(`/events/${events[0]!.id}`).set(reader).expect(200);
      expect(event.body).toMatchObject({ eventType: 'POLICY_CANCELLED', policyVersion: 2, deliveries: [{ id: d.id, status: 'SUCCEEDED', attemptCount: 2 }] });

      const detail = await http().get(`/deliveries/${d.id}`).set(reader).expect(200);
      expect(detail.body).toMatchObject({ eventType: 'POLICY_CANCELLED', policyId: policy.id, status: 'SUCCEEDED', nextAttemptAt: null });
      expect(detail.body.attempts.map((a: { attemptNumber: number; outcome: string; responseStatus: number }) => [a.attemptNumber, a.outcome, a.responseStatus])).toEqual([
        [1, 'HTTP_ERROR', 500],
        [2, 'SUCCESS', 200],
      ]);
      const failedOnly = await http().get('/deliveries?status=FAILED').set(admin).expect(200);
      expect(failedOnly.body.data).toEqual([]);
    } finally {
      await target.close();
    }
  });
});

describe('OpenAPI contract', () => {
  it('every documented operation is implemented (no route falls through to ROUTE_NOT_FOUND)', async () => {
    const spec = loadOpenApiSpec() as { paths: Record<string, Record<string, unknown>> };
    const sample: Record<string, string> = { '{id}': newId('pol') };
    const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((m) => ['get', 'post', 'patch', 'delete'].includes(m))
        .map((method) => ({ method, path })),
    );
    expect(operations.length).toBeGreaterThanOrEqual(21);
    for (const { method, path } of operations) {
      const prefix = path.startsWith('/events') ? 'evt' : path.startsWith('/subscriptions') ? 'sub' : path.startsWith('/deliveries') ? 'dlv' : 'pol';
      const url = path.replace('{id}', sample['{id}']!.replace('pol', prefix));
      const res = await (http() as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set(admin).send({});
      expect({ method, path, code: res.body?.error?.code }).not.toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    }
  });
});
