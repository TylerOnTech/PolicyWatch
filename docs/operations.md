# Operations: observability, failure handling, runbook

## Structured logging

- One JSON object per line (pino) on stdout: `level` (numeric) + `severity`, `time` (ISO-8601),
  `service`, `version`, `msg`, and context fields (`policyId`, `carrierId`, `deliveryId`, `eventId`,
  `failureCategory`, …).
- **Correlation IDs**: the API accepts a well-formed `X-Request-Id` or mints one, echoes it, and
  binds it to an `AsyncLocalStorage` context. It travels into the check job, is stored on the check
  and its events, and the outbox relay hands it to the delivery jobs. `correlationId` is attached
  to every log line written inside that context — one ID follows a change from API call to webhook.
- **PII**: the code logs identifiers, not policy contents. As a second line of defense, pino redacts
  `authorization`/`cookie` headers, secrets, `policyholder`, `drivers`, `email`, `phone`,
  `dateOfBirth` and `password` at any nesting depth used. Request logs record method, path (no query
  string) and status only. Webhook bodies contain no policyholder data at all.

## Metrics

Prometheus format (`prom-client`), per process:

| Endpoint | Process |
|---|---|
| `GET /metrics` (read-only API key) | API |
| `GET :3001/metrics` (internal port) | Worker |

| Metric | Labels | Use |
|---|---|---|
| `policywatch_policy_checks_total` | `carrier`, `outcome`, `failure_category` | Carrier health per carrier and failure type |
| `policywatch_policy_check_duration_seconds` | `carrier` | Carrier latency |
| `policywatch_events_generated_total` | `event_type` | Business volume |
| `policywatch_webhook_attempts_total` | `outcome` | Delivery success rate |
| `policywatch_webhook_attempt_duration_seconds` | `outcome` | Subscriber latency |
| `policywatch_webhook_deliveries_finalized_total` | `status` | Terminal outcomes (SUCCEEDED/FAILED/CANCELLED) |
| `policywatch_sweeper_recovered_total` | `kind` | Should be ~0; non-zero means lost jobs |
| `policywatch_outbox_pending` | — | Relay lag |
| `policywatch_queue_jobs` | `queue`, `state` | Backlog (waiting/active/delayed/failed) |
| `policywatch_background_loop_errors_total` | `loop` | Scheduler/relay/sweeper health |
| `policywatch_http_requests_total`, `…_duration_seconds` | `method`, `route`, `status` | API traffic (route templates keep cardinality bounded) |

On AWS, CloudWatch metric filters derive `ErrorLogLines`, `WebhookDeliveryFailures`,
`WebhookRetriesScheduled`, `PolicyCheckFailures` and `BackgroundLoopErrors` from the JSON logs, and
the CloudWatch agent adds memory, swap and disk.

## Health

| Probe | Meaning |
|---|---|
| `GET /health/live` | API process is serving (container liveness) |
| `GET /health` | PostgreSQL + Redis reachable (503 if not) and live workers from heartbeats. `degraded` (HTTP 200) when no worker is alive or a worker's loop has failed ≥ 3 times in a row |
| `GET :3001/health` (worker) | BullMQ consumers running and each background loop's last success / consecutive errors (503 when degraded) |

Workers write a heartbeat key to Redis every 10 s with a 30 s TTL; the API lists live workers from those.

## Failure categories

| Category | Typical cause | Transient | Effect |
|---|---|---|---|
| `CARRIER_TIMEOUT` | No response within `CARRIER_TIMEOUT_MS`, 408/504 | yes | Backoff, policy state unchanged |
| `CARRIER_UNAVAILABLE` | Connection refused/reset, 5xx | yes | Backoff (honors `Retry-After`) |
| `CARRIER_RATE_LIMITED` | 429 | yes | Backoff ≥ `Retry-After` |
| `CARRIER_DATA_UNAVAILABLE` | 200 with "processing"/"maintenance" status | yes | Backoff |
| `CARRIER_AUTH_FAILED` | 401/403 | no | Needs credential fix |
| `CARRIER_REQUEST_REJECTED` | Other 4xx | no | Needs investigation |
| `POLICY_NOT_FOUND` | 404 or carrier "not found" status | no | **Not** treated as cancellation |
| `INVALID_CARRIER_RESPONSE` | Malformed JSON/XML, schema violation, unknown status code, wrong policy returned | no | Carrier contract drift |
| `INTERNAL_ERROR` | Adapter bug | no | Needs a code fix |

Check failure backoff: `min(interval, CHECK_FAILURE_BACKOFF_BASE_SECONDS · 2^(failures−1))` + ≤10%
jitter, never shorter than a carrier `Retry-After`.

## Configuration reference (selected)

| Variable | Default | Notes |
|---|---|---|
| `DEFAULT_CHECK_INTERVAL_SECONDS` / `MIN_CHECK_INTERVAL_SECONDS` | 3600 / 60 | Per-policy interval set at enrollment or `PATCH /policies/:id` |
| `SCHEDULER_TICK_MS`, `SCHEDULER_BATCH_SIZE`, `SCHEDULER_LEASE_SECONDS` | 5000, 100, 300 | Lease = how long a queued check "owns" the policy |
| `CARRIER_TIMEOUT_MS`, `CARRIER_MAX_RESPONSE_BYTES` | 5000, 1 MiB | |
| `CHECK_CONCURRENCY`, `DELIVERY_CONCURRENCY` | 5, 10 | Per worker process |
| `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_ATTEMPTS` | 5000, 8 | |
| `WEBHOOK_BACKOFF_BASE_MS`, `WEBHOOK_BACKOFF_MAX_MS` | 2000, 900000 | Use ≥ 30000 base in production |
| `WEBHOOK_LOCK_SECONDS` | 60 | Must comfortably exceed the webhook timeout |
| `SWEEPER_INTERVAL_MS`, `SWEEPER_STALE_AFTER_MS` | 15000, 60000 | |
| `WEBHOOK_REQUIRE_HTTPS` | `true` in production | |
| `WEBHOOK_ALLOWED_HOSTS` | empty | Development only (bypasses SSRF checks for exact hostnames) |
| `SHUTDOWN_TIMEOUT_MS` | 25000 | Keep below the orchestrator's kill timeout |

All configuration is validated with Zod at startup; the process refuses to start and lists every
problem (e.g. short API keys, a 31-byte encryption key) instead of failing later.

## Runbook

**A carrier is failing.** `GET /policies?…` shows `monitoring.lastFailureCategory`; the metric
`policywatch_policy_checks_total{outcome="FAILED"}` by `carrier` and `failure_category` shows scope.
Transient categories back off automatically. For `CARRIER_AUTH_FAILED`, rotate the carrier
credential in configuration and restart the worker. Nothing to clean up afterwards: failed checks
never changed policy state.

**Deliveries to one subscriber are failing.** `GET /deliveries?subscriptionId=…&status=RETRY_SCHEDULED`
and `GET /deliveries/:id` (attempt trail with status codes and response snippets). Once the
subscriber is fixed, scheduled retries continue on their own; for `FAILED` deliveries use
`POST /deliveries/:id/retry`. To stop traffic, `PATCH /subscriptions/:id {"active": false}`.

**Redis lost its data.** No data loss: deliveries are rows in PostgreSQL. Within
`SWEEPER_STALE_AFTER_MS` the sweeper re-enqueues overdue deliveries, and after
`SCHEDULER_LEASE_SECONDS` the scheduler re-enqueues policy checks.

**A worker was killed mid-delivery.** Its delivery stays `IN_PROGRESS` until `locked_until`
passes, then the sweeper re-enqueues it and the attempt is retried with the same attempt number. The
subscriber may see that request twice (de-duplicated by `eventId`).

**Rotating a subscriber's signing secret.** Not yet an API operation (see known limitations). Today:
create a new subscription, let the consumer accept both secrets (the receiver supports a secret list),
then delete the old subscription.
