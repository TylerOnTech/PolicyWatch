import type { CheckOutcome, CheckTrigger, Policy, Prisma } from '@prisma/client';
import { CarrierError, type FailureCategory } from '../carriers/types.js';
import type { AppDeps } from '../deps.js';
import { detectChanges } from '../domain/diff.js';
import { EVENT_SCHEMA_VERSION, eventDedupeKey, type EventType } from '../domain/events.js';
import { snapshotHash } from '../domain/normalize.js';
import { NormalizedPolicySchema, type NormalizedPolicy } from '../domain/normalized-policy.js';
import { errorMessage, isUniqueViolation } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nextCheckAfterFailure, nextRoutineCheck } from './scheduling.js';

export type MonitoringDeps = Pick<AppDeps, 'prisma' | 'carriers' | 'logger' | 'metrics' | 'config' | 'clock'> & {
  /** Invoked after a transaction that produced events commits (lets the worker wake the outbox relay). */
  onEventsCommitted?: () => void;
};

export interface CheckResult {
  checkId: string;
  policyId: string;
  outcome: CheckOutcome;
  failureCategory: FailureCategory | null;
  snapshotVersion: number | null;
  events: Array<{ id: string; eventType: EventType }>;
  durationMs: number;
}

export class PolicyNotEnrolledError extends Error {
  constructor(policyId: string) {
    super(`Policy ${policyId} is not enrolled`);
    this.name = 'PolicyNotEnrolledError';
  }
}

interface CheckContext {
  trigger: CheckTrigger;
  correlationId?: string;
  startedAt: Date;
  t0: number;
}

const MAX_PERSIST_ATTEMPTS = 3;
const toDateOnly = (isoDate: string) => new Date(`${isoDate}T00:00:00.000Z`);

/**
 * One monitoring pass for one policy:
 *   fetch → normalize/validate → (lock policy row) → compare with current snapshot →
 *   write snapshot + events + outbox rows + check record in ONE transaction.
 *
 * Network I/O happens before the transaction opens, so no row lock is held while waiting on a carrier.
 * Carrier failures are recorded as FAILED checks and never mutate policy state.
 */
export async function checkPolicy(
  deps: MonitoringDeps,
  policyId: string,
  opts: { trigger: CheckTrigger; correlationId?: string },
): Promise<CheckResult> {
  const ctx: CheckContext = { ...opts, startedAt: deps.clock(), t0: performance.now() };
  const policy = await deps.prisma.policy.findUnique({ where: { id: policyId } });
  if (!policy) throw new PolicyNotEnrolledError(policyId);
  const log = deps.logger.child({ policyId, carrierId: policy.carrierId, trigger: opts.trigger });

  let fetched: { policy: NormalizedPolicy; httpStatus: number } | undefined;
  let failure: CarrierError | undefined;
  const adapter = deps.carriers.get(policy.carrierId);
  if (!adapter) {
    failure = new CarrierError('INTERNAL_ERROR', `No adapter is registered for carrier '${policy.carrierId}'`);
  } else {
    try {
      fetched = await adapter.fetchPolicy(policy.externalPolicyId, { correlationId: opts.correlationId });
      const p = fetched.policy;
      if (p.carrierId !== policy.carrierId || p.externalPolicyId.toUpperCase() !== policy.externalPolicyId.toUpperCase()) {
        failure = new CarrierError('INVALID_CARRIER_RESPONSE', 'Carrier returned a different policy than the one requested', fetched.httpStatus);
      }
    } catch (err) {
      if (err instanceof CarrierError) {
        failure = err;
      } else {
        log.error({ err }, 'carrier adapter threw an unclassified error');
        failure = new CarrierError('INTERNAL_ERROR', `Adapter error: ${errorMessage(err)}`);
      }
    }
  }

  const result =
    failure || !fetched
      ? await recordFailedCheck(deps, policy, failure!, ctx)
      : await persistRetrieval(deps, policy, fetched.policy, fetched.httpStatus, ctx);

  const labels = { carrier: policy.carrierId, outcome: result.outcome, failure_category: result.failureCategory ?? 'none' };
  deps.metrics.policyChecks.inc(labels);
  deps.metrics.policyCheckDuration.observe({ carrier: policy.carrierId }, result.durationMs / 1000);
  for (const e of result.events) deps.metrics.eventsGenerated.inc({ event_type: e.eventType });

  if (result.outcome === 'FAILED') {
    log.warn(
      { checkId: result.checkId, failureCategory: result.failureCategory, httpStatus: failure?.httpStatus, transient: failure?.transient },
      'policy check failed; stored policy state left unchanged',
    );
  } else if (result.events.length > 0 || result.outcome === 'BASELINE') {
    log.info(
      { checkId: result.checkId, outcome: result.outcome, version: result.snapshotVersion, eventTypes: result.events.map((e) => e.eventType) },
      'policy check recorded changes',
    );
  } else {
    log.debug({ checkId: result.checkId, outcome: result.outcome }, 'policy check complete');
  }

  if (result.events.length > 0) deps.onEventsCommitted?.();
  return result;
}

async function persistRetrieval(
  deps: MonitoringDeps,
  policy: Policy,
  fetched: NormalizedPolicy,
  httpStatus: number,
  ctx: CheckContext,
): Promise<CheckResult> {
  const hash = snapshotHash(fetched);
  const retrievedAt = new Date(fetched.retrievedAt);

  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.prisma.$transaction(
        async (tx) => {
          // Serializes concurrent checks of the same policy (scheduled + manual, or two workers).
          const locked = await tx.$queryRaw<Array<{ current_version: number }>>`
            SELECT current_version FROM policies WHERE id = ${policy.id} FOR UPDATE`;
          if (locked.length === 0) throw new PolicyNotEnrolledError(policy.id);
          const currentVersion = locked[0]!.current_version;
          const current =
            currentVersion > 0
              ? await tx.policySnapshot.findUnique({
                  where: { policyId_version: { policyId: policy.id, version: currentVersion } },
                })
              : null;

          let outcome: CheckOutcome;
          let version: number | null = currentVersion > 0 ? currentVersion : null;
          let events: Prisma.PolicyEventCreateManyInput[] = [];

          if (current && current.retrievedAt > retrievedAt) {
            // A slower, older response lost the race to a newer one. Applying it would roll state back.
            outcome = 'STALE_DISCARDED';
          } else if (current && current.contentHash === hash) {
            outcome = 'UNCHANGED';
          } else {
            const previous = current ? NormalizedPolicySchema.parse(current.data) : null;
            const changes = previous ? detectChanges(previous, fetched) : [];
            const newVersion = currentVersion + 1;
            version = newVersion;

            await tx.policySnapshot.create({
              data: {
                id: newId('snp'),
                policyId: policy.id,
                version: newVersion,
                contentHash: hash,
                data: fetched as unknown as Prisma.InputJsonValue,
                retrievedAt,
              },
            });

            events = changes.map((change) => ({
              id: newId('evt'),
              policyId: policy.id,
              carrierId: policy.carrierId,
              externalPolicyId: policy.externalPolicyId,
              eventType: change.type,
              schemaVersion: EVENT_SCHEMA_VERSION,
              policyVersion: newVersion,
              previousVersion: currentVersion,
              dedupeKey: eventDedupeKey(policy.id, newVersion, change),
              data: change.data as unknown as Prisma.InputJsonValue,
              occurredAt: retrievedAt,
              correlationId: ctx.correlationId ?? null,
            }));
            if (events.length > 0) {
              // Event rows and their outbox rows commit atomically with the snapshot: no event can be
              // lost (committed without an outbox row) or phantom (published without being committed).
              await tx.policyEvent.createMany({ data: events });
              await tx.outboxMessage.createMany({
                data: events.map((e) => ({ id: newId('obx'), eventId: e.id!, topic: 'policy.event' })),
              });
            }
            outcome = previous ? 'CHANGED' : 'BASELINE';
          }

          const now = deps.clock();
          const contentChanged = outcome === 'CHANGED' || outcome === 'BASELINE';
          await tx.policy.update({
            where: { id: policy.id },
            data: {
              ...(contentChanged
                ? {
                    currentVersion: version!,
                    status: fetched.status,
                    policyType: fetched.policyType,
                    effectiveDate: toDateOnly(fetched.effectiveDate),
                    expirationDate: toDateOnly(fetched.expirationDate),
                    premiumCents: fetched.premium.amountCents,
                    premiumCurrency: fetched.premium.currency,
                  }
                : {}),
              lastCheckedAt: now,
              lastSuccessfulCheckAt: now,
              lastCheckOutcome: outcome,
              lastFailureCategory: null,
              consecutiveFailures: 0,
              nextCheckAt: nextRoutineCheck(now, policy.checkIntervalSeconds),
            },
          });

          const durationMs = Math.round(performance.now() - ctx.t0);
          const check = await tx.policyCheck.create({
            data: {
              id: newId('chk'),
              policyId: policy.id,
              trigger: ctx.trigger,
              outcome,
              httpStatus,
              snapshotVersion: version,
              eventsGenerated: events.length,
              durationMs,
              correlationId: ctx.correlationId ?? null,
              startedAt: ctx.startedAt,
              completedAt: now,
            },
          });

          return {
            checkId: check.id,
            policyId: policy.id,
            outcome,
            failureCategory: null,
            snapshotVersion: version,
            events: events.map((e) => ({ id: e.id!, eventType: e.eventType as EventType })),
            durationMs,
          };
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
    } catch (err) {
      // A concurrent transaction won the race for this version; re-read and re-evaluate.
      if (attempt < MAX_PERSIST_ATTEMPTS && isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

async function recordFailedCheck(
  deps: MonitoringDeps,
  policy: Policy,
  failure: CarrierError,
  ctx: CheckContext,
): Promise<CheckResult> {
  const now = deps.clock();
  const durationMs = Math.round(performance.now() - ctx.t0);
  const checkId = newId('chk');
  const nextCheckAt = nextCheckAfterFailure(now, {
    intervalSeconds: policy.checkIntervalSeconds,
    consecutiveFailures: policy.consecutiveFailures + 1,
    baseSeconds: deps.config.monitoring.failureBackoffBaseSeconds,
    retryAfterSeconds: failure.retryAfterSeconds,
  });

  // Only monitoring metadata changes. status, snapshots and events are untouched: an unreachable or
  // untrustworthy carrier tells us nothing about whether the policy was cancelled or expired.
  await deps.prisma.$transaction([
    deps.prisma.policyCheck.create({
      data: {
        id: checkId,
        policyId: policy.id,
        trigger: ctx.trigger,
        outcome: 'FAILED',
        failureCategory: failure.category,
        errorMessage: failure.message.slice(0, 500),
        httpStatus: failure.httpStatus ?? null,
        durationMs,
        correlationId: ctx.correlationId ?? null,
        startedAt: ctx.startedAt,
        completedAt: now,
      },
    }),
    deps.prisma.policy.update({
      where: { id: policy.id },
      data: {
        lastCheckedAt: now,
        lastCheckOutcome: 'FAILED',
        lastFailureCategory: failure.category,
        consecutiveFailures: { increment: 1 },
        nextCheckAt,
      },
    }),
  ]);

  return {
    checkId,
    policyId: policy.id,
    outcome: 'FAILED',
    failureCategory: failure.category,
    snapshotVersion: policy.currentVersion > 0 ? policy.currentVersion : null,
    events: [],
    durationMs,
  };
}
