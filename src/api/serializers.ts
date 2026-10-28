import type {
  DeliveryAttempt,
  Policy,
  PolicyCheck,
  PolicyEvent,
  PolicySnapshot,
  WebhookDelivery,
  WebhookSubscription,
} from '@prisma/client';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export function serializePolicy(p: Policy) {
  return {
    id: p.id,
    carrierId: p.carrierId,
    externalPolicyId: p.externalPolicyId,
    status: p.status,
    policyType: p.policyType,
    effectiveDate: dateOnly(p.effectiveDate),
    expirationDate: dateOnly(p.expirationDate),
    premium: p.premiumCents !== null && p.premiumCurrency ? { amountCents: p.premiumCents, currency: p.premiumCurrency } : null,
    currentVersion: p.currentVersion,
    monitoring: {
      enabled: p.monitoringEnabled,
      checkIntervalSeconds: p.checkIntervalSeconds,
      nextCheckAt: iso(p.nextCheckAt),
      lastCheckedAt: iso(p.lastCheckedAt),
      lastSuccessfulCheckAt: iso(p.lastSuccessfulCheckAt),
      lastCheckOutcome: p.lastCheckOutcome,
      lastFailureCategory: p.lastFailureCategory,
      consecutiveFailures: p.consecutiveFailures,
    },
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

export function serializeSnapshot(s: PolicySnapshot, opts: { includeData: boolean }) {
  return {
    id: s.id,
    version: s.version,
    contentHash: s.contentHash,
    retrievedAt: iso(s.retrievedAt),
    createdAt: iso(s.createdAt),
    ...(opts.includeData ? { policy: s.data } : {}),
  };
}

export function serializeCheck(c: PolicyCheck) {
  return {
    id: c.id,
    policyId: c.policyId,
    trigger: c.trigger,
    outcome: c.outcome,
    failureCategory: c.failureCategory,
    errorMessage: c.errorMessage,
    httpStatus: c.httpStatus,
    snapshotVersion: c.snapshotVersion,
    eventsGenerated: c.eventsGenerated,
    durationMs: c.durationMs,
    correlationId: c.correlationId,
    startedAt: iso(c.startedAt),
    completedAt: iso(c.completedAt),
  };
}

export function serializeEvent(e: PolicyEvent) {
  return {
    id: e.id,
    eventType: e.eventType,
    schemaVersion: e.schemaVersion,
    policyId: e.policyId,
    carrierId: e.carrierId,
    externalPolicyId: e.externalPolicyId,
    policyVersion: e.policyVersion,
    previousVersion: e.previousVersion,
    occurredAt: iso(e.occurredAt),
    createdAt: iso(e.createdAt),
    data: e.data,
  };
}

export function serializeSubscription(s: WebhookSubscription) {
  return {
    id: s.id,
    url: s.url,
    description: s.description,
    eventTypes: s.eventTypes,
    carrierIds: s.carrierIds,
    status: s.status,
    secretHint: `…${s.secretHint}`,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

export function serializeDelivery(d: WebhookDelivery & { event?: Pick<PolicyEvent, 'eventType' | 'policyId'> | null }) {
  const scheduled = d.status === 'PENDING' || d.status === 'RETRY_SCHEDULED';
  return {
    id: d.id,
    subscriptionId: d.subscriptionId,
    eventId: d.eventId,
    ...(d.event ? { eventType: d.event.eventType, policyId: d.event.policyId } : {}),
    status: d.status,
    attemptCount: d.attemptCount,
    maxAttempts: d.maxAttempts,
    manualRetryCount: d.manualRetryCount,
    nextAttemptAt: scheduled ? iso(d.nextAttemptAt) : null,
    lastAttemptAt: iso(d.lastAttemptAt),
    lastResponseStatus: d.lastResponseStatus,
    lastError: d.lastError,
    succeededAt: iso(d.succeededAt),
    failedAt: iso(d.failedAt),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

export function serializeAttempt(a: DeliveryAttempt) {
  return {
    id: a.id,
    attemptNumber: a.attemptNumber,
    trigger: a.trigger,
    outcome: a.outcome,
    destinationHost: a.destinationHost,
    responseStatus: a.responseStatus,
    responseBodySnippet: a.responseBodySnippet,
    errorMessage: a.errorMessage,
    signatureTimestamp: a.signatureTimestamp,
    durationMs: a.durationMs,
    startedAt: iso(a.startedAt),
    completedAt: iso(a.completedAt),
  };
}
