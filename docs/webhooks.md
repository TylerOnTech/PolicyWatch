# Webhooks

## Subscribing

```bash
curl -s -X POST http://localhost:3000/subscriptions \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"url":"https://hooks.example.com/policywatch","eventTypes":["POLICY_CANCELLED","POLICY_EXPIRED"],"carrierIds":[]}'
```

- `eventTypes`: one or more event types, or `["*"]` for all.
- `carrierIds`: optional filter; empty means every carrier.
- The response includes `secret` (`whsec_…`) **once**. PolicyWatch stores it AES-256-GCM encrypted;
  later reads show only `secretHint` (last four characters).
- Subscriptions receive events created *after* they exist (no back-fill).
- `PATCH /subscriptions/:id {"active": false}` deactivates and cancels queued deliveries;
  `DELETE` soft-deletes (delivery history stays auditable).

## Request

```
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: PolicyWatch-Webhooks/1.0
PolicyWatch-Event-Id: evt_01m61rcaccqa9xmp6zarkm9ewd
PolicyWatch-Event-Type: POLICY_CANCELLED
PolicyWatch-Delivery-Id: dlv_01m61rcackym28b4n1j6p1x4p1
PolicyWatch-Attempt: 2
PolicyWatch-Timestamp: 1793145600
PolicyWatch-Signature: v1=153f715bee7b3346f2b41ccbd0fee41eb37f1df303ad581b5c8f760c2228e761
```

```json
{
  "eventId": "evt_01m61rcaccqa9xmp6zarkm9ewd",
  "eventType": "POLICY_CANCELLED",
  "schemaVersion": "1.0",
  "occurredAt": "2026-10-28T00:00:00.000Z",
  "policyId": "pol_01m61rca2k98dhcpdnhhxwgwzb",
  "carrierId": "acme",
  "externalPolicyId": "ACM-AUTO-100234",
  "policyVersion": 2,
  "previousVersion": 1,
  "data": {
    "previousStatus": "ACTIVE",
    "currentStatus": "CANCELLED",
    "term": { "effectiveDate": "2026-05-01", "expirationDate": "2026-11-01" }
  }
}
```

- `eventId` is stable across every retry and manual redelivery of the event.
- `occurredAt` is when PolicyWatch **observed** the change (the retrieval that revealed it), not a
  carrier-side timestamp.
- `policyVersion`/`previousVersion` reference `GET /policies/{policyId}/history`.
- Payloads deliberately carry **no policyholder PII** (names, contact details, driver data). Fetch
  details with `GET /policies/{policyId}` if you are authorized to.
- The body is byte-identical on every attempt; only the timestamp, signature and attempt headers change.

### `data` by event type

| Event | Emitted when | `data` |
|---|---|---|
| `POLICY_CANCELLED` | status changes to `CANCELLED` | `previousStatus`, `currentStatus`, `term` |
| `POLICY_REINSTATED` | `CANCELLED`/`EXPIRED` → `ACTIVE` on the **same** term | same as above |
| `POLICY_EXPIRED` | status changes to `EXPIRED` (carrier-confirmed; never inferred from dates) | same as above |
| `POLICY_RENEWED` | `ACTIVE` with a term strictly later than before (both dates advance) | `previousTerm`, `currentTerm`, `previousStatus`, `currentStatus` |
| `PREMIUM_CHANGED` | amount or currency differs | `previous`, `current` (`amountCents`, `currency`), `deltaCents` (null across currencies) |
| `COVERAGE_CHANGED` | policy- or vehicle-level coverage added, removed, or limits/deductible changed | `changes[]`: `change` (`ADDED`/`REMOVED`/`MODIFIED`), `coverageType`, `carrierCode`, `vehicleVin`, `previous`, `current` |
| `VEHICLE_ADDED` / `VEHICLE_REMOVED` | VIN appears / disappears (one event per vehicle) | `vehicle`, `coverages` that arrived/left with it |

Detection rules worth knowing:

- One retrieval can produce several events, in a fixed order: lifecycle → premium → coverage →
  vehicles removed → vehicles added.
- A renewal with a new premium produces both `POLICY_RENEWED` and `PREMIUM_CHANGED`: each event
  type is an independent fact, so a consumer interested only in premiums never has to parse renewals.
- Coverages that come or go *with a vehicle* are reported inside `VEHICLE_ADDED`/`VEHICLE_REMOVED`
  and not repeated in `COVERAGE_CHANGED`.
- Changes with no v1 event type (contact details, drivers, vehicle description fixes, `PENDING` →
  `ACTIVE`) create a new snapshot version but no event.

## Verifying signatures

```
signed_payload = "<PolicyWatch-Timestamp>.<raw request body>"
expected       = hex( HMAC-SHA256( key = your secret (the whole "whsec_…" string), signed_payload ) )
```

Compare `expected` with each `v1=` value in `PolicyWatch-Signature` (comma-separated; several may be
present) using a constant-time comparison. Use the **raw** bytes you received — parsing and
re-serializing JSON changes the bytes and breaks the signature.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const SECRETS = [process.env.POLICYWATCH_WEBHOOK_SECRET!]; // add the old secret during rotation
const TOLERANCE_SECONDS = 300;

app.post('/policywatch', express.text({ type: 'application/json' }), (req, res) => {
  const ts = req.header('PolicyWatch-Timestamp') ?? '';
  const sigs = (req.header('PolicyWatch-Signature') ?? '')
    .split(',').map((s) => s.trim()).filter((s) => s.startsWith('v1=')).map((s) => s.slice(3));

  // 1. Replay protection: reject stale (or future) timestamps.
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_SECONDS) return res.sendStatus(400);

  // 2. Authenticity: HMAC over "<timestamp>.<raw body>".
  const valid = SECRETS.some((secret) => {
    const expected = createHmac('sha256', secret).update(`${ts}.${req.body}`).digest();
    return sigs.some((s) => /^[0-9a-f]{64}$/.test(s) && timingSafeEqual(Buffer.from(s, 'hex'), expected));
  });
  if (!valid) return res.sendStatus(401);

  const event = JSON.parse(req.body);
  // 3. De-duplicate on event.eventId (see below), then acknowledge quickly.
  res.sendStatus(200);
});
```

A complete working consumer is `src/simulators/mock-receiver/app.ts`, and the same verification
function ships as `verifySignature()` in `src/webhooks/signing.ts`.

### Why the timestamp is inside the MAC

An attacker who captures a request cannot replay it later: the timestamp would be outside the
tolerance window, and changing the timestamp header invalidates the signature. Within the window,
`eventId` de-duplication makes a replay harmless.

## Delivery guarantees

**At-least-once.** Every event is delivered to every matching subscription at least once, unless the
subscription is deactivated or the attempts run out. It may arrive **more than once**:

- the receiver processed a request but the response was lost or timed out;
- a worker died after sending and before recording the result;
- an operator triggered a manual redelivery.

PolicyWatch does not promise exactly-once delivery — no protocol across an unreliable network can.

**No global ordering.** Retries mean a later event can arrive before an earlier one. Use
`policyVersion` per `policyId` to order or to ignore stale information.

### De-duplication

Store processed `eventId`s (with a unique constraint) and treat a repeat as success:

```sql
INSERT INTO processed_policywatch_events (event_id, received_at) VALUES ($1, now())
ON CONFLICT (event_id) DO NOTHING;   -- 0 rows inserted → duplicate: acknowledge with 2xx and stop
```

Do the insert in the same transaction as your side effects so a crash cannot record the ID without
the effect (or vice versa).

## Retries

| Outcome | Retried? |
|---|---|
| 2xx | Done (`SUCCEEDED`) |
| Timeout (no response within `WEBHOOK_TIMEOUT_MS`, default 5 s), connection error | Yes |
| 408, 425, 429, 5xx | Yes (`Retry-After` honored, capped at `WEBHOOK_BACKOFF_MAX_MS`) |
| 3xx (redirects are not followed), other 4xx | No — `FAILED` immediately |
| Destination blocked by SSRF policy | No — `FAILED` |

Backoff is exponential with "equal jitter": after failed attempt *n* the next attempt waits a
uniformly random time in `[d/2, d]`, `d = min(WEBHOOK_BACKOFF_MAX_MS, WEBHOOK_BACKOFF_BASE_MS · 2^(n−1))`.
With production settings (base 30 s, cap 15 min, 8 attempts) retries span roughly half an hour;
the local demo uses a 2 s base so they fit on screen.

After the last attempt the delivery is `FAILED` and logged as `webhook delivery failed permanently`
(which feeds a CloudWatch metric and alarm). `POST /deliveries/:id/retry` re-sends it with a fresh
attempt budget.

## Inspecting deliveries

- `GET /deliveries?eventId=…`, `?subscriptionId=…`, `?status=FAILED`
- `GET /deliveries/:id` — every attempt: number, trigger (`AUTOMATIC`/`MANUAL`), outcome, HTTP
  status, first 512 bytes of the response, duration, signature timestamp.
- `GET /events/:id` — the event plus a per-subscription delivery summary.

## SSRF protections

Subscriber URLs are attacker-controllable input, and the worker runs inside a cloud network, so:

1. **At subscription time** (`400 INVALID_WEBHOOK_URL`): only `https` (plain `http` is accepted
   solely for explicitly allowlisted development hosts); no credentials in the URL; no ports below
   1024 other than 80/443; no `localhost`, `*.local`, `*.internal`, metadata hostnames or single-label
   names (Docker service names such as `redis`); IP literals in loopback, private, link-local
   (169.254.169.254 metadata), CGNAT, multicast, reserved, IPv6 ULA/link-local and IPv4-mapped
   ranges are rejected. Exotic spellings (`2130706433`, `0x7f.1`, `127.1`) are canonicalized by the
   WHATWG URL parser before checking. The hostname is resolved, and any private answer is rejected.
2. **At every delivery**: the URL is re-validated, and DNS resolution happens inside the socket's
   own `lookup` hook, which refuses private answers — so the address that is checked is the address
   that is connected to (defeats DNS rebinding between validation and delivery).
3. **Redirects are never followed**, so a public endpoint cannot bounce the request inward.
4. **Response bodies are capped** (2 KiB read, 512 bytes stored) and requests time out.
5. **Infrastructure backstop**: on AWS, IMDSv2 is required with a hop limit of 1, so even a
   bypass from inside a container could not reach instance credentials.

`WEBHOOK_ALLOWED_HOSTS` exempts exact hostnames from address checks for local development (the
bundled `mock-receiver`). It must be empty wherever real subscriber URLs are accepted.
