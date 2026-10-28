# Demo walkthrough (≈ 3 minutes)

`scripts/demo.ts` drives the running stack over HTTP only — the same calls an integrator would make.
Each run creates a fresh synthetic policy, so it is repeatable without resetting anything.

```bash
docker compose run --rm demo                       # Docker
npm run demo                                       # services running locally (npm run dev)
DEMO_STEP_PAUSE_MS=12000 npm run demo              # paced for a live presentation (~3 min)
```

Unpaced, the run takes about 6 seconds (webhook backoff base is 2 s locally).

| # | What happens | What to point out |
|---|---|---|
| 1 | A new Acme policy (`ACM-DEMO-…`) is created at the simulated carrier and enrolled with `POST /policies`. The worker fetches it. | Baseline = version 1, **no events** (nothing to compare with). |
| 2 | `POST /subscriptions` for lifecycle events from Acme; the secret is handed to the receiver. | Secret returned once, stored encrypted. URL passed SSRF checks. |
| 3 | The carrier flips the policy to `CANCELLED`; the receiver starts answering 503. | Carrier change and subscriber outage, both outside PolicyWatch. |
| 4 | `POST /policies/:id/check?wait=true` with an `X-Request-Id`. | Outcome `CHANGED`, snapshot v2, ~10 ms. |
| 5 | The `POLICY_CANCELLED` event is printed. | Committed in the same transaction as snapshot and outbox row. |
| 6 | First delivery attempt → 503 → `RETRY_SCHEDULED` with `nextAttemptAt`. | The failure is recorded; nothing is lost. |
| 7 | Second attempt also fails; attempt timestamps show the growing gap. | Exponential backoff with jitter. |
| 8 | The receiver recovers. | — |
| 9 | Third attempt → 200 → `SUCCEEDED`. The receiver confirms every attempt's signature was valid. | Same `eventId` and body on every attempt. |
| 10 | `GET /policies/:id/history` (v1 ACTIVE, v2 CANCELLED + event) and `GET /deliveries/:id` (three attempts). | Full audit trail. |
| + | `POST /deliveries/:id/retry` → the receiver flags the repeat as a **duplicate** and acknowledges without reprocessing. | At-least-once delivery + consumer de-duplication. |

Real output from a local run:

```
 4. Trigger a policy refresh
[+  0.4s] check CHANGED → snapshot v2 in 10 ms (X-Request-Id demo-mvsdq54s)
 5. Cancellation event generated (committed atomically with the snapshot and outbox row)
[+  0.4s] POLICY_CANCELLED evt_01m61rcaccqa9xmp6zarkm9ewd
 6. First webhook delivery fails
[+  0.7s] delivery dlv_01m61rcackym28b4n1j6p1x4p1: attempt 1 → HTTP 503, status RETRY_SCHEDULED
 7. Automatic retries with backoff
[+  2.5s] attempt 1: HTTP_ERROR 503 at 17:19:30.205
[+  2.5s] attempt 2: HTTP_ERROR 503 at 17:19:32.193
 9. Delivery succeeds on the next scheduled retry
[+  6.1s] delivery SUCCEEDED after 3 attempts
[+  6.1s] receiver saw attempt 3: signature valid, responded 200
10. Policy history and delivery audit trail
[+  6.1s] v2 CANCELLED hash f5923b091e2d… events: POLICY_CANCELLED
[+  6.1s] v1 ACTIVE    hash 04fdfeabe395… events: —
    Bonus: manual redelivery — same eventId, receiver de-duplicates
[+  6.3s] receiver got evt_01m61rcaccqa9xmp6zarkm9ewd again → flagged duplicate=true, acknowledged 200 without reprocessing
```

## Things to try by hand

```bash
source .env   # ADMIN_API_KEY etc.
H="Authorization: Bearer $ADMIN_API_KEY"

# A carrier outage is not a cancellation
curl -s -X POST localhost:4000/_admin/faults -H 'content-type: application/json' -d '{"carrierId":"bluebird","mode":"http_503"}'
curl -s -X POST "localhost:3000/policies/<pol_id>/check?wait=true" -H "$H" | jq '.check | {outcome, failureCategory}'

# Formatting noise does not create versions
curl -s -X POST localhost:4000/_admin/noise -H 'content-type: application/json' -d '{"enabled":true}'

# Renewal with a new premium → POLICY_RENEWED + PREMIUM_CHANGED
curl -s -X PATCH localhost:4000/_admin/policies/cardinal/CC-7902-2026 -H 'content-type: application/json' \
  -d '{"renew":{"termMonths":6,"premiumCents":61200}}'

# SSRF protection
curl -s -X POST localhost:3000/subscriptions -H "$H" -H 'content-type: application/json' \
  -d '{"url":"http://169.254.169.254/latest/meta-data/","eventTypes":["*"]}' | jq .error
```

Simulator fault modes: `http_500`, `http_503`, `timeout`, `rate_limited`, `data_unavailable`,
`malformed`, `not_found`, `auth_error` (add `"remaining": N` to limit the number of affected
requests). Receiver modes: `ok`, `fail` (with `status`), `timeout`, `flaky` (with `failCount`).
