import { compareCoverages } from './normalize.js';
import type { Coverage, NormalizedPolicy } from './normalized-policy.js';
import type { CoverageChange, CoverageSnapshot, DetectedChange, Term } from './events.js';

/**
 * Semantic change detection between two normalized snapshots of the same policy.
 *
 * Pure and deterministic: the same (previous, current) pair always yields the same events in the same
 * order. Each detector is independent and compares typed fields — never serialized JSON. Fields that
 * have no v1 event type (policyholder contact details, drivers, vehicle descriptions) can change
 * without emitting anything; the new snapshot still records them.
 *
 * Output order: lifecycle (status/term) → premium → coverage → vehicles removed → vehicles added,
 * vehicles sorted by VIN.
 */
export function detectChanges(previous: NormalizedPolicy, current: NormalizedPolicy): DetectedChange[] {
  if (previous.carrierId !== current.carrierId || previous.externalPolicyId !== current.externalPolicyId) {
    throw new Error('detectChanges: snapshots belong to different policies');
  }
  const vehicleChanges = detectVehicleChanges(previous, current);
  return [
    ...detectLifecycleChange(previous, current),
    ...detectPremiumChange(previous, current),
    ...detectCoverageChange(previous, current, vehicleChanges.affectedVins),
    ...vehicleChanges.events,
  ];
}

const termOf = (p: NormalizedPolicy): Term => ({ effectiveDate: p.effectiveDate, expirationDate: p.expirationDate });

function detectLifecycleChange(prev: NormalizedPolicy, curr: NormalizedPolicy): DetectedChange[] {
  // ISO calendar dates compare correctly as strings.
  const termAdvanced = curr.effectiveDate > prev.effectiveDate && curr.expirationDate > prev.expirationDate;

  // Renewal: the carrier now reports a later term that is in force. Takes precedence over the raw
  // status transition (EXPIRED → ACTIVE on a new term is a renewal, not a reinstatement).
  if (termAdvanced && curr.status === 'ACTIVE') {
    return [
      {
        type: 'POLICY_RENEWED',
        discriminator: '',
        data: {
          previousTerm: termOf(prev),
          currentTerm: termOf(curr),
          previousStatus: prev.status,
          currentStatus: curr.status,
        },
      },
    ];
  }

  if (prev.status === curr.status) return [];
  const data = { previousStatus: prev.status, currentStatus: curr.status, term: termOf(curr) };

  switch (curr.status) {
    case 'CANCELLED':
      return [{ type: 'POLICY_CANCELLED', discriminator: '', data }];
    case 'EXPIRED':
      return [{ type: 'POLICY_EXPIRED', discriminator: '', data }];
    case 'ACTIVE':
      // Back in force on the same term after a cancellation or lapse.
      if (prev.status === 'CANCELLED' || prev.status === 'EXPIRED') {
        return [{ type: 'POLICY_REINSTATED', discriminator: '', data }];
      }
      return []; // PENDING → ACTIVE (issuance) has no v1 event type
    case 'PENDING':
      return [];
  }
}

function detectPremiumChange(prev: NormalizedPolicy, curr: NormalizedPolicy): DetectedChange[] {
  const a = prev.premium;
  const b = curr.premium;
  if (a.amountCents === b.amountCents && a.currency === b.currency) return [];
  return [
    {
      type: 'PREMIUM_CHANGED',
      discriminator: '',
      data: {
        previous: { ...a },
        current: { ...b },
        deltaCents: a.currency === b.currency ? b.amountCents - a.amountCents : null,
      },
    },
  ];
}

const coverageKey = (c: Coverage) => `${c.vehicleVin ?? 'POLICY'}|${c.type}|${c.carrierCode}`;

const snapshotOf = (c: Coverage): CoverageSnapshot => ({
  type: c.type,
  carrierCode: c.carrierCode,
  vehicleVin: c.vehicleVin,
  limitPerPersonCents: c.limitPerPersonCents,
  limitPerOccurrenceCents: c.limitPerOccurrenceCents,
  deductibleCents: c.deductibleCents,
});

const sameTerms = (a: Coverage, b: Coverage) =>
  a.limitPerPersonCents === b.limitPerPersonCents &&
  a.limitPerOccurrenceCents === b.limitPerOccurrenceCents &&
  a.deductibleCents === b.deductibleCents;

function detectCoverageChange(
  prev: NormalizedPolicy,
  curr: NormalizedPolicy,
  vinsAddedOrRemoved: ReadonlySet<string>,
): DetectedChange[] {
  // Coverages that arrive/leave with a vehicle are reported on the VEHICLE_* event instead.
  const relevant = (c: Coverage) => c.vehicleVin === null || !vinsAddedOrRemoved.has(c.vehicleVin);
  const before = new Map(prev.coverages.filter(relevant).map((c) => [coverageKey(c), c]));
  const after = new Map(curr.coverages.filter(relevant).map((c) => [coverageKey(c), c]));

  const changes: Array<CoverageChange & { sortKey: Coverage }> = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) {
      changes.push({ change: 'REMOVED', ...identity(b), previous: snapshotOf(b), current: null, sortKey: b });
    } else if (!sameTerms(b, a)) {
      changes.push({ change: 'MODIFIED', ...identity(a), previous: snapshotOf(b), current: snapshotOf(a), sortKey: a });
    }
  }
  for (const [key, a] of after) {
    if (!before.has(key)) {
      changes.push({ change: 'ADDED', ...identity(a), previous: null, current: snapshotOf(a), sortKey: a });
    }
  }
  if (changes.length === 0) return [];

  changes.sort((x, y) => compareCoverages(x.sortKey, y.sortKey));
  return [
    {
      type: 'COVERAGE_CHANGED',
      discriminator: '',
      data: { changes: changes.map(({ sortKey: _s, ...rest }) => rest) },
    },
  ];
}

const identity = (c: Coverage) => ({ coverageType: c.type, carrierCode: c.carrierCode, vehicleVin: c.vehicleVin });

function detectVehicleChanges(prev: NormalizedPolicy, curr: NormalizedPolicy) {
  const before = new Map(prev.vehicles.map((v) => [v.vin, v]));
  const after = new Map(curr.vehicles.map((v) => [v.vin, v]));
  const removed = [...before.keys()].filter((vin) => !after.has(vin)).sort();
  const added = [...after.keys()].filter((vin) => !before.has(vin)).sort();

  const coveragesFor = (p: NormalizedPolicy, vin: string) =>
    p.coverages.filter((c) => c.vehicleVin === vin).map(snapshotOf);

  const events: DetectedChange[] = [
    ...removed.map(
      (vin): DetectedChange => ({
        type: 'VEHICLE_REMOVED',
        discriminator: vin,
        data: { vehicle: { ...before.get(vin)! }, coverages: coveragesFor(prev, vin) },
      }),
    ),
    ...added.map(
      (vin): DetectedChange => ({
        type: 'VEHICLE_ADDED',
        discriminator: vin,
        data: { vehicle: { ...after.get(vin)! }, coverages: coveragesFor(curr, vin) },
      }),
    ),
  ];
  return { events, affectedVins: new Set([...removed, ...added]) };
}
