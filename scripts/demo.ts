/**
 * PolicyWatch three-minute demonstration. Drives the running stack over HTTP only (API, carrier
 * simulator, mock receiver) — exactly what an external client would see.
 *
 *   docker compose --profile demo run --rm demo     (inside Compose)
 *   npm run demo                                    (services running on localhost)
 *
 * Every run uses a freshly created synthetic policy, so the demo is repeatable without resetting
 * the database.
 */
const env = process.env;
const API = env.API_URL ?? 'http://127.0.0.1:3000';
const SIM = env.CARRIER_SIM_URL ?? 'http://127.0.0.1:4000';
const RECEIVER = env.RECEIVER_URL ?? 'http://127.0.0.1:4100';
const WEBHOOK_URL = env.RECEIVER_WEBHOOK_URL ?? `${RECEIVER}/webhooks`;
const KEY = env.ADMIN_API_KEY;
if (!KEY) {
  console.error('ADMIN_API_KEY is not set (copy .env.example to .env).');
  process.exit(1);
}

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const started = Date.now();
const elapsed = () => c.dim(`[+${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`);
// For live presentation: DEMO_STEP_PAUSE_MS=12000 paces the ten steps to roughly three minutes.
const PAUSE_MS = Number(env.DEMO_STEP_PAUSE_MS ?? 0);
const step = async (n: number, title: string) => {
  if (PAUSE_MS > 0 && n > 1) await sleep(PAUSE_MS);
  console.log(`\n${c.bold(c.cyan(`${String(n).padStart(2)}. ${title}`))}`);
};
const info = (msg: string) => console.log(`${elapsed()} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T = Record<string, unknown>>(base: string, path: string, init: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.auth === false ? {} : { authorization: `Bearer ${KEY}` }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${base}${path} → ${res.status} ${text.slice(0, 300)}`);
  return json as T;
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(250);
  }
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

interface Attempt { attemptNumber: number; outcome: string; responseStatus: number | null; startedAt: string; durationMs: number; trigger: string }
interface Delivery { id: string; status: string; attemptCount: number; nextAttemptAt: string | null; lastResponseStatus: number | null; attempts?: Attempt[] }

async function main() {
  console.log(c.bold('PolicyWatch demo — synthetic carrier data only'));
  const health = await call<{ status: string; checks: { workers: { count: number } } }>(API, '/health', { auth: false });
  info(`API ${health.status}, ${health.checks.workers.count} worker(s) live`);
  if (health.checks.workers.count === 0) throw new Error('No worker is running — start it first.');
  await call(RECEIVER, '/_control/reset', { method: 'POST', auth: false });

  // 1 ──────────────────────────────────────────────────────────────────────────────────────────────
  await step(1, 'Create an active synthetic auto policy at "Acme Mutual" and enroll it');
  const policyNumber = `ACM-DEMO-${Date.now().toString(36).toUpperCase()}`;
  await call(SIM, '/_admin/policies', { method: 'POST', auth: false, body: { carrierId: 'acme', policyNumber } });
  const enrolled = await call<{ id: string }>(API, '/policies', { method: 'POST', body: { carrierId: 'acme', externalPolicyId: policyNumber } });
  const policy = await until('baseline snapshot', async () => {
    const p = await call<{ currentVersion: number; status: string; premium: { amountCents: number }; effectiveDate: string; expirationDate: string }>(API, `/policies/${enrolled.id}`);
    return p.currentVersion === 1 ? p : null;
  });
  info(`${c.bold(policyNumber)} → ${enrolled.id}`);
  info(`baseline v1: status ${c.green(policy.status)}, premium ${money(policy.premium.amountCents)}, term ${policy.effectiveDate} → ${policy.expirationDate}`);

  // 2 ──────────────────────────────────────────────────────────────────────────────────────────────
  await step(2, 'Register a webhook subscription (lifecycle events from Acme)');
  const sub = await call<{ id: string; secret: string }>(API, '/subscriptions', {
    method: 'POST',
    body: { url: WEBHOOK_URL, eventTypes: ['POLICY_CANCELLED', 'POLICY_REINSTATED', 'POLICY_RENEWED', 'POLICY_EXPIRED'], carrierIds: ['acme'], description: 'demo' },
  });
  await call(RECEIVER, '/_control/secrets', { method: 'POST', auth: false, body: { secrets: [sub.secret] } });
  info(`subscription ${sub.id} → ${WEBHOOK_URL}`);
  info(`signing secret ${sub.secret.slice(0, 10)}… shared with the receiver (shown once, stored encrypted)`);

  // 3 ──────────────────────────────────────────────────────────────────────────────────────────────
  await step(3, 'The carrier cancels the policy (and, meanwhile, the subscriber endpoint goes down)');
  await call(SIM, `/_admin/policies/acme/${policyNumber}`, { method: 'PATCH', auth: false, body: { status: 'CANCELLED' } });
  await call(RECEIVER, '/_control/mode', { method: 'POST', auth: false, body: { mode: 'fail', status: 503 } });
  info(`carrier now reports ${c.red('CANCELLED')}; receiver now answers ${c.red('503')}`);

  // 4 + 5 ──────────────────────────────────────────────────────────────────────────────────────────
  await step(4, 'Trigger a policy refresh');
  const correlationId = `demo-${Date.now().toString(36)}`;
  const result = await call<{ check: { outcome: string; snapshotVersion: number; durationMs: number }; events: Array<{ id: string; eventType: string; data: unknown }> }>(
    API,
    `/policies/${enrolled.id}/check?wait=true`,
    { method: 'POST', headers: { 'x-request-id': correlationId } },
  );
  info(`check ${c.bold(result.check.outcome)} → snapshot v${result.check.snapshotVersion} in ${result.check.durationMs} ms (X-Request-Id ${correlationId})`);

  await step(5, 'Cancellation event generated (committed atomically with the snapshot and outbox row)');
  const event = result.events.find((e) => e.eventType === 'POLICY_CANCELLED');
  if (!event) throw new Error('expected a POLICY_CANCELLED event');
  info(`${c.bold(event.eventType)} ${event.id}`);
  info(c.dim(JSON.stringify(event.data)));

  // 6 + 7 ──────────────────────────────────────────────────────────────────────────────────────────
  await step(6, 'First webhook delivery fails');
  const first = await until('first failed attempt', async () => {
    const page = await call<{ data: Delivery[] }>(API, `/deliveries?eventId=${event.id}&subscriptionId=${sub.id}`);
    const d = page.data[0];
    return d && d.attemptCount >= 1 && d.status === 'RETRY_SCHEDULED' ? d : null;
  });
  info(`delivery ${first.id}: attempt 1 → HTTP ${c.red(String(first.lastResponseStatus))}, status ${c.yellow(first.status)}`);
  info(`next attempt at ${first.nextAttemptAt} (exponential backoff with jitter)`);

  await step(7, 'Automatic retries with backoff');
  const second = await until('second failed attempt', async () => {
    const d = await call<Delivery>(API, `/deliveries/${first.id}`);
    return d.attemptCount >= 2 && d.status === 'RETRY_SCHEDULED' ? d : null;
  });
  for (const a of second.attempts ?? []) {
    info(`attempt ${a.attemptNumber}: ${a.outcome} ${a.responseStatus ?? ''} at ${a.startedAt.slice(11, 23)}`);
  }
  info(`next attempt at ${second.nextAttemptAt} — the gap doubles each time`);

  // 8 + 9 ──────────────────────────────────────────────────────────────────────────────────────────
  await step(8, 'Subscriber endpoint recovers');
  await call(RECEIVER, '/_control/mode', { method: 'POST', auth: false, body: { mode: 'ok' } });
  info(`receiver now answers ${c.green('200')}`);

  await step(9, 'Delivery succeeds on the next scheduled retry');
  const done = await until('successful delivery', async () => {
    const d = await call<Delivery>(API, `/deliveries/${first.id}`);
    return d.status === 'SUCCEEDED' ? d : null;
  });
  const receiver = await call<{ received: Array<{ deliveryId: string; attempt: number; signatureValid: boolean; respondedWith: number | string }> }>(RECEIVER, '/_control/state', { auth: false });
  info(`delivery ${c.green('SUCCEEDED')} after ${done.attemptCount} attempts`);
  for (const r of receiver.received.filter((x) => x.deliveryId === first.id)) {
    info(`receiver saw attempt ${r.attempt}: signature ${r.signatureValid ? c.green('valid') : c.red('INVALID')}, responded ${r.respondedWith}`);
  }

  // 10 ─────────────────────────────────────────────────────────────────────────────────────────────
  await step(10, 'Policy history and delivery audit trail');
  const history = await call<{ data: Array<{ version: number; contentHash: string; retrievedAt: string; policy: { status: string }; events: Array<{ eventType: string }> }> }>(API, `/policies/${enrolled.id}/history`);
  for (const s of history.data) {
    info(`v${s.version} ${s.policy.status.padEnd(9)} hash ${s.contentHash.slice(0, 12)}… events: ${s.events.map((e) => e.eventType).join(', ') || '—'}`);
  }
  const audit = await call<Delivery>(API, `/deliveries/${first.id}`);
  for (const a of audit.attempts ?? []) {
    info(`attempt ${a.attemptNumber} ${a.trigger.padEnd(9)} ${a.outcome.padEnd(10)} ${String(a.responseStatus ?? '-').padEnd(4)} ${a.durationMs} ms`);
  }

  // Bonus: at-least-once + consumer de-duplication
  console.log(`\n${c.bold(c.cyan('    Bonus: manual redelivery — same eventId, receiver de-duplicates'))}`);
  await call(API, `/deliveries/${first.id}/retry`, { method: 'POST' });
  const dup = await until('redelivery', async () => {
    const s = await call<{ received: Array<{ deliveryId: string; duplicate: boolean; respondedWith: number }> }>(RECEIVER, '/_control/state', { auth: false });
    return s.received.find((r) => r.deliveryId === first.id && r.duplicate) ?? null;
  });
  info(`receiver got ${event.id} again → flagged duplicate=${dup.duplicate}, acknowledged ${dup.respondedWith} without reprocessing`);

  console.log(`\n${c.green(c.bold(`Demo complete in ${((Date.now() - started) / 1000).toFixed(1)} s.`))} Explore: ${API}/docs`);
}

main().catch((err: unknown) => {
  console.error(c.red(`\nDemo failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
