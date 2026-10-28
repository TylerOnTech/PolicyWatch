# Design decisions and trade-offs

Each entry records the decision, the alternatives, and what was given up.

## 1. PostgreSQL is the source of truth; Redis only triggers work

**Decision.** Every durable fact — snapshots, events, outbox rows, delivery state, attempts — lives in
PostgreSQL. BullMQ jobs carry only an ID. Workers re-read state and claim rows with conditional
updates, so any job can be run twice, late, or not at all without corrupting anything; a sweeper
re-creates missing jobs from the database.

**Alternatives.** Let BullMQ own retry state (`attempts` + custom backoff); or a broker such as SQS
with DLQs.

**Trade-off.** More SQL and an extra recovery loop, and the database carries all coordination load.
In exchange: Redis can be flushed with no data loss, retry state is queryable through the API, and
behavior is identical on a laptop and on AWS. At much higher volume, deliveries would move to a
partitioned queue (SQS/Kafka) and the claim pattern would become the idempotency layer.

## 2. Transactional outbox instead of publishing after commit

**Decision.** Events and their outbox rows are inserted in the same transaction as the snapshot.
A relay turns outbox rows into deliveries in a second transaction.

**Alternatives.** Enqueue directly after commit (dual write, can lose events on a crash); CDC/logical
replication (Debezium) reading the WAL.

**Trade-off.** Delivery latency gains one relay hop (milliseconds here, because the check wakes the
relay in-process; up to `OUTBOX_POLL_INTERVAL_MS` across processes) and the outbox table needs
pruning. CDC would avoid polling but adds a whole platform component.

## 3. At-least-once delivery with consumer de-duplication, not "exactly-once"

**Decision.** Stable `eventId`, byte-identical bodies across retries, an atomic claim that prevents
*concurrent* duplicate sends, and documented consumer de-duplication. The remaining duplicate window
(sent but not recorded) is acknowledged, not hidden.

**Alternatives.** Claim exactly-once; or two-phase protocols with receivers.

**Trade-off.** Consumers must store processed IDs. This is the honest contract every major webhook
provider uses; claiming more would be false.

## 4. Typed semantic differ + canonical hash, not JSON comparison

**Decision.** Adapters normalize aggressively into a strict schema; a canonical-JSON SHA-256 decides
*whether* to store a version; a pure, field-aware differ decides *what* changed, with explicit
rules (renewal precedence over status transitions, vehicle-scoped coverages folded into vehicle
events, fixed output order).

**Alternatives.** Generic deep-diff of raw payloads; hashing raw responses.

**Trade-off.** Every new field must be modeled explicitly, and fields without an event type change the
version silently. In return, formatting noise cannot produce events (proven by tests that render each
policy two ways), and every event has a precise, documented meaning.

## 5. Unavailable data is never a state change

**Decision.** Every non-trustworthy response is a classified `FAILED` check that changes only
monitoring metadata. Expiration is reported only when the carrier says `EXPIRED`, never inferred
from `expirationDate`.

**Trade-off.** A carrier that silently stops returning a policy (404 forever) is surfaced as a
monitoring problem rather than a cancellation; a policy past its expiration date stays `ACTIVE` until
the carrier confirms. Downstream systems get fewer, but correct, events — false cancellations in
insurance trigger real-world actions (outreach, coverage gaps), so false positives cost more than
latency.

## 6. Field-specific event types over one generic `POLICY_CHANGED`

**Decision.** Eight event types, each independent; one retrieval may emit several (a renewal with a
new premium emits `POLICY_RENEWED` and `PREMIUM_CHANGED`).

**Trade-off.** Consumers interested in "anything changed" subscribe to `*` and may receive several
events per change. Consumers interested in one fact never parse others.

## 7. Single EC2 host with Docker Compose, configured by Ansible

**Decision.** Terraform provisions a VPC, one public subnet, a t4g.small with an Elastic IP,
IAM, CloudWatch and snapshots. Ansible configures the OS and deploys the Compose stack, including
PostgreSQL and Redis as containers.

**Alternatives.** ECS Fargate + RDS + ElastiCache + ALB (≈ $80–120/month minimum); EKS.

**Trade-off.** ~$18/month and a clear role for Ansible, but a single point of failure: no multi-AZ,
crash-consistent EBS snapshots instead of point-in-time recovery, and deploys briefly restart
containers. The application is already stateless and multi-worker-safe, so moving the datastores
to RDS/ElastiCache and the processes to ECS is a configuration change, not a redesign.

## 8. Secrets in SSM Parameter Store, read on the host by the instance role

**Decision.** `put-secrets.sh` generates values locally and writes SecureString parameters;
Ansible reads them **on the instance** with its IAM role and renders a root-only `.env`.

**Alternatives.** Terraform `random_password` (secrets in state); Ansible Vault (secrets in git);
Secrets Manager ($0.40/secret/month, rotation features).

**Trade-off.** No automatic rotation; containers read secrets from an environment file, so anything
with Docker access on the host can see them. Secrets never touch Terraform state, git, or the
operator's disk.

## 9. Hand-written OpenAPI with a contract test

**Decision.** `openapi/openapi.yaml` is authored by hand; a test sends a request to every documented
operation and fails if any falls through to `ROUTE_NOT_FOUND`.

**Trade-off.** Request/response schemas can drift from the Zod schemas (only route existence is
enforced). Generating the spec from Zod would close that gap at the cost of a code-generation
dependency.

## 10. Pinned, conservative dependency majors

Prisma 6 (not 7's driver-adapter architecture), TypeScript 5.9 (not the 7.x native compiler),
BullMQ 5, Vitest 4. `npm audit` is clean; a dev-only transitive advisory in the Prisma CLI is fixed
with an `overrides` entry, and `.npmrc` sets `legacy-peer-deps` to work around an npm resolver bug
with Vitest 4's optional peer graph.
