import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { loadConfig } from '../../src/config.js';
import { closeDeps, createDeps, type AppDeps } from '../../src/deps.js';
import { newId } from '../../src/lib/ids.js';
import { silentLogger } from '../../src/lib/logger.js';
import { checkPolicy, type CheckResult } from '../../src/monitoring/check-policy.js';
import { createCarrierSimApp } from '../../src/simulators/carrier-sim/app.js';
import { applyMutation, type SimMutation, type SimStore } from '../../src/simulators/carrier-sim/store.js';
import { TEST_ENV } from './env.js';

export interface Listening {
  url: string;
  server: http.Server;
  close(): Promise<void>;
}

export async function listen(handler: Express | http.RequestListener): Promise<Listening> {
  const server = http.createServer(handler as http.RequestListener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface TestContext {
  deps: AppDeps;
  sim: Listening & { store: SimStore };
  close(): Promise<void>;
}

export async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const { app, store, clearTimers } = createCarrierSimApp({
    acmeApiKey: 'sim-acme-api-key',
    bluebirdToken: 'sim-bluebird-token',
    cardinalUsername: 'policywatch',
    cardinalPassword: 'sim-cardinal-password',
    timeoutDelayMs: 1_500,
  });
  const sim = await listen(app);
  const config = loadConfig({ ...TEST_ENV, CARRIER_SIM_BASE_URL: sim.url, ...env });
  const deps = createDeps(config, { logger: silentLogger });
  return {
    deps,
    sim: { ...sim, store },
    async close() {
      clearTimers();
      await closeDeps(deps);
      await sim.close();
    },
  };
}

/** Wipe all tables and queues between tests. */
export async function resetState(ctx: TestContext): Promise<void> {
  await ctx.deps.prisma.$executeRawUnsafe(
    'TRUNCATE delivery_attempts, webhook_deliveries, webhook_subscriptions, outbox_messages, policy_events, policy_checks, policy_snapshots, policies CASCADE',
  );
  await Promise.all([ctx.deps.queues.checks.obliterate({ force: true }), ctx.deps.queues.deliveries.obliterate({ force: true })]);
  ctx.sim.store.reset();
}

/** Insert a monitored policy row directly (no queue side effects). */
export async function insertPolicy(deps: AppDeps, carrierId: string, externalPolicyId: string) {
  return deps.prisma.policy.create({
    data: {
      id: newId('pol'),
      carrierId,
      externalPolicyId,
      checkIntervalSeconds: 3600,
      nextCheckAt: new Date(Date.now() + 3_600_000),
    },
  });
}

export async function check(deps: AppDeps, policyId: string): Promise<CheckResult> {
  return checkPolicy(deps, policyId, { trigger: 'MANUAL', correlationId: 'test-correlation-id' });
}

export async function enrollWithBaseline(ctx: TestContext, carrierId: string, externalPolicyId: string) {
  const policy = await insertPolicy(ctx.deps, carrierId, externalPolicyId);
  const baseline = await check(ctx.deps, policy.id);
  if (baseline.outcome !== 'BASELINE') throw new Error(`baseline failed: ${JSON.stringify(baseline)}`);
  return policy;
}

/** Change a policy at the simulated carrier, as an underwriting or billing system would. */
export function mutate(ctx: TestContext, carrierId: string, policyNumber: string, mutation: SimMutation): void {
  const current = ctx.sim.store.get(carrierId, policyNumber);
  if (!current) throw new Error(`no sim policy ${carrierId}/${policyNumber}`);
  ctx.sim.store.put(applyMutation(current, mutation));
}

export interface RecordedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
  at: number;
}

export interface WebhookTarget extends Listening {
  requests: RecordedRequest[];
  /** Status (or 'hang') to answer with; consulted per request. May be async to hold a request open. */
  respond: (req: RecordedRequest, index: number) => number | 'hang' | Promise<number>;
}

/** A bare HTTP endpoint that records every webhook request it receives. */
export async function startWebhookTarget(): Promise<WebhookTarget> {
  const target = { requests: [] as RecordedRequest[], respond: (() => 200) as WebhookTarget['respond'] };
  const listening = await listen((req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const record = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() };
      target.requests.push(record);
      const status = await target.respond(record, target.requests.length - 1);
      if (status === 'hang') return; // never answer: the sender must time out
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: status < 300 }));
    });
  });
  return Object.assign(target, listening);
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 50));
  }
}
