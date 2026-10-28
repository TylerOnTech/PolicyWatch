import type { Coverage, Premium, PolicyStatus, Vehicle } from './normalized-policy.js';

export const EVENT_SCHEMA_VERSION = '1.0' as const;

export const EVENT_TYPES = [
  'POLICY_CANCELLED',
  'POLICY_REINSTATED',
  'POLICY_RENEWED',
  'POLICY_EXPIRED',
  'COVERAGE_CHANGED',
  'PREMIUM_CHANGED',
  'VEHICLE_ADDED',
  'VEHICLE_REMOVED',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface Term {
  effectiveDate: string;
  expirationDate: string;
}

export interface StatusChangeData {
  previousStatus: PolicyStatus;
  currentStatus: PolicyStatus;
  term: Term;
}

export interface RenewalData {
  previousTerm: Term;
  currentTerm: Term;
  previousStatus: PolicyStatus;
  currentStatus: PolicyStatus;
}

export interface PremiumChangeData {
  previous: Premium;
  current: Premium;
  /** current − previous when currencies match, otherwise null. */
  deltaCents: number | null;
}

export type CoverageSnapshot = Pick<
  Coverage,
  'type' | 'carrierCode' | 'vehicleVin' | 'limitPerPersonCents' | 'limitPerOccurrenceCents' | 'deductibleCents'
>;

export interface CoverageChange {
  change: 'ADDED' | 'REMOVED' | 'MODIFIED';
  coverageType: Coverage['type'];
  carrierCode: string;
  vehicleVin: string | null;
  previous: CoverageSnapshot | null;
  current: CoverageSnapshot | null;
}

export interface CoverageChangeData {
  changes: CoverageChange[];
}

export interface VehicleChangeData {
  vehicle: Vehicle;
  /** Vehicle-level coverages that arrived/left with the vehicle (not repeated in COVERAGE_CHANGED). */
  coverages: CoverageSnapshot[];
}

export type DetectedChange =
  | { type: 'POLICY_CANCELLED' | 'POLICY_REINSTATED' | 'POLICY_EXPIRED'; discriminator: ''; data: StatusChangeData }
  | { type: 'POLICY_RENEWED'; discriminator: ''; data: RenewalData }
  | { type: 'PREMIUM_CHANGED'; discriminator: ''; data: PremiumChangeData }
  | { type: 'COVERAGE_CHANGED'; discriminator: ''; data: CoverageChangeData }
  | { type: 'VEHICLE_ADDED' | 'VEHICLE_REMOVED'; discriminator: string; data: VehicleChangeData };

/** Deterministic idempotency key. A given policy version can produce each (type, discriminator) once. */
export function eventDedupeKey(policyId: string, version: number, change: Pick<DetectedChange, 'type' | 'discriminator'>) {
  return `${policyId}:v${version}:${change.type}:${change.discriminator}`;
}

/** The webhook body (schemaVersion 1.0). Contains no policyholder PII; consumers fetch details by ID. */
export interface WebhookEventPayload {
  eventId: string;
  eventType: EventType;
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  occurredAt: string;
  policyId: string;
  carrierId: string;
  externalPolicyId: string;
  policyVersion: number;
  previousVersion: number;
  data: DetectedChange['data'];
}

export function buildWebhookPayload(event: {
  id: string;
  eventType: EventType;
  occurredAt: Date;
  policyId: string;
  carrierId: string;
  externalPolicyId: string;
  policyVersion: number;
  previousVersion: number;
  data: unknown;
}): WebhookEventPayload {
  // Fixed key order keeps the body byte-identical across retries of the same event.
  return {
    eventId: event.id,
    eventType: event.eventType,
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: event.occurredAt.toISOString(),
    policyId: event.policyId,
    carrierId: event.carrierId,
    externalPolicyId: event.externalPolicyId,
    policyVersion: event.policyVersion,
    previousVersion: event.previousVersion,
    data: event.data as DetectedChange['data'],
  };
}
