import { describe, expect, it } from 'vitest';
import { detectChanges } from '../../src/domain/diff.js';
import type { NormalizedPolicy } from '../../src/domain/normalized-policy.js';
import { basePolicy } from '../fixtures/policies.js';

const types = (prev: NormalizedPolicy, curr: NormalizedPolicy) => detectChanges(prev, curr).map((c) => c.type);

describe('detectChanges — lifecycle', () => {
  it('emits nothing for an identical policy fetched later', () => {
    const prev = basePolicy();
    expect(detectChanges(prev, basePolicy({ retrievedAt: '2026-10-29T00:00:00.000Z' }))).toEqual([]);
  });

  it('detects a confirmed cancellation', () => {
    const changes = detectChanges(basePolicy(), basePolicy({ status: 'CANCELLED' }));
    expect(changes).toEqual([
      {
        type: 'POLICY_CANCELLED',
        discriminator: '',
        data: {
          previousStatus: 'ACTIVE',
          currentStatus: 'CANCELLED',
          term: { effectiveDate: '2026-05-01', expirationDate: '2026-11-01' },
        },
      },
    ]);
  });

  it('detects cancellation of a pending (not yet effective) policy', () => {
    expect(types(basePolicy({ status: 'PENDING' }), basePolicy({ status: 'CANCELLED' }))).toEqual(['POLICY_CANCELLED']);
  });

  it('detects reinstatement on the same term', () => {
    expect(types(basePolicy({ status: 'CANCELLED' }), basePolicy({ status: 'ACTIVE' }))).toEqual(['POLICY_REINSTATED']);
  });

  it('detects expiration only when the carrier reports EXPIRED', () => {
    expect(types(basePolicy(), basePolicy({ status: 'EXPIRED' }))).toEqual(['POLICY_EXPIRED']);
  });

  it('does not infer expiration from dates alone (carrier still says ACTIVE past expirationDate)', () => {
    const pastTerm = { effectiveDate: '2025-01-01', expirationDate: '2025-07-01' };
    expect(types(basePolicy(pastTerm), basePolicy({ ...pastTerm, retrievedAt: '2026-10-28T00:00:00.000Z' }))).toEqual([]);
  });

  it('detects renewal when an ACTIVE policy moves to a later term', () => {
    const changes = detectChanges(basePolicy(), basePolicy({ effectiveDate: '2026-11-01', expirationDate: '2027-05-01' }));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: 'POLICY_RENEWED',
      data: {
        previousTerm: { effectiveDate: '2026-05-01', expirationDate: '2026-11-01' },
        currentTerm: { effectiveDate: '2026-11-01', expirationDate: '2027-05-01' },
      },
    });
  });

  it('treats EXPIRED → ACTIVE on a new term as a renewal, not a reinstatement', () => {
    const prev = basePolicy({ status: 'EXPIRED' });
    const curr = basePolicy({ status: 'ACTIVE', effectiveDate: '2026-11-01', expirationDate: '2027-11-01' });
    expect(types(prev, curr)).toEqual(['POLICY_RENEWED']);
  });

  it('reports a renewal and a premium change independently', () => {
    const curr = basePolicy({ effectiveDate: '2026-11-01', expirationDate: '2027-05-01', premium: { amountCents: 69_900, currency: 'USD' } });
    expect(types(basePolicy(), curr)).toEqual(['POLICY_RENEWED', 'PREMIUM_CHANGED']);
  });

  it('does not report a renewal for a new term that is not yet in force', () => {
    const curr = basePolicy({ status: 'PENDING', effectiveDate: '2026-11-01', expirationDate: '2027-05-01' });
    expect(types(basePolicy(), curr)).toEqual([]);
  });

  it('has no event for PENDING → ACTIVE (issuance)', () => {
    expect(types(basePolicy({ status: 'PENDING' }), basePolicy({ status: 'ACTIVE' }))).toEqual([]);
  });

  it('refuses to diff two different policies', () => {
    expect(() => detectChanges(basePolicy(), basePolicy({ externalPolicyId: 'OTHER-1' }))).toThrow(/different policies/);
  });
});

describe('detectChanges — premium', () => {
  it('reports amount change with delta', () => {
    const [change] = detectChanges(basePolicy(), basePolicy({ premium: { amountCents: 70_000, currency: 'USD' } }));
    expect(change).toEqual({
      type: 'PREMIUM_CHANGED',
      discriminator: '',
      data: { previous: { amountCents: 64_250, currency: 'USD' }, current: { amountCents: 70_000, currency: 'USD' }, deltaCents: 5_750 },
    });
  });

  it('reports currency change without a delta', () => {
    const [change] = detectChanges(basePolicy(), basePolicy({ premium: { amountCents: 64_250, currency: 'CAD' } }));
    expect(change?.type).toBe('PREMIUM_CHANGED');
    expect(change?.data).toMatchObject({ deltaCents: null });
  });
});

describe('detectChanges — coverage', () => {
  it('reports limit, deductible, added and removed coverages in one event, in canonical order', () => {
    const prev = basePolicy();
    const curr = basePolicy({
      coverages: [
        { ...prev.coverages[0]!, limitPerPersonCents: 25_000_000, limitPerOccurrenceCents: 50_000_000 },
        // PD removed
        { ...prev.coverages[2]!, deductibleCents: 100_000 },
        {
          type: 'MEDICAL_PAYMENTS',
          carrierCode: 'MEDPAY',
          vehicleVin: null,
          limitPerPersonCents: 500_000,
          limitPerOccurrenceCents: null,
          deductibleCents: null,
        },
      ],
    });
    const changes = detectChanges(prev, curr);
    expect(changes.map((c) => c.type)).toEqual(['COVERAGE_CHANGED']);
    const data = changes[0]!.data as { changes: Array<{ change: string; coverageType: string }> };
    expect(data.changes.map((c) => `${c.change}:${c.coverageType}`)).toEqual([
      'MODIFIED:BODILY_INJURY_LIABILITY',
      'ADDED:MEDICAL_PAYMENTS',
      'REMOVED:PROPERTY_DAMAGE_LIABILITY',
      'MODIFIED:COLLISION',
    ]);
  });

  it('is insensitive to coverage array order', () => {
    const prev = basePolicy();
    expect(detectChanges(prev, basePolicy({ coverages: [...prev.coverages].reverse() }))).toEqual([]);
  });
});

describe('detectChanges — vehicles', () => {
  const newVehicle = { vin: '5YJ3E1EA7PF000202', year: 2023, make: 'Tesla', model: 'Model 3' };
  const newVehicleCoverage = {
    type: 'COLLISION' as const,
    carrierCode: 'COLL',
    vehicleVin: newVehicle.vin,
    limitPerPersonCents: null,
    limitPerOccurrenceCents: null,
    deductibleCents: 100_000,
  };

  it('reports an added vehicle with its coverages and does NOT repeat them as COVERAGE_CHANGED', () => {
    const prev = basePolicy();
    const curr = basePolicy({ vehicles: [...prev.vehicles, newVehicle], coverages: [...prev.coverages, newVehicleCoverage] });
    const changes = detectChanges(prev, curr);
    expect(changes.map((c) => c.type)).toEqual(['VEHICLE_ADDED']);
    expect(changes[0]).toMatchObject({ discriminator: newVehicle.vin, data: { vehicle: newVehicle, coverages: [{ type: 'COLLISION' }] } });
  });

  it('reports a removed vehicle', () => {
    const prev = basePolicy();
    const curr = basePolicy({ vehicles: [], coverages: prev.coverages.filter((c) => c.vehicleVin === null) });
    const changes = detectChanges(prev, curr);
    expect(changes.map((c) => c.type)).toEqual(['VEHICLE_REMOVED']);
    expect(changes[0]!.discriminator).toBe('1HGCV1F30MA000101');
  });

  it('reports a vehicle swap as one removal and one addition (removals first)', () => {
    const prev = basePolicy();
    const curr = basePolicy({
      vehicles: [newVehicle],
      coverages: [...prev.coverages.filter((c) => c.vehicleVin === null), newVehicleCoverage],
    });
    expect(types(prev, curr)).toEqual(['VEHICLE_REMOVED', 'VEHICLE_ADDED']);
  });

  it('ignores vehicle description corrections on the same VIN (no v1 event type)', () => {
    const prev = basePolicy();
    expect(detectChanges(prev, basePolicy({ vehicles: [{ ...prev.vehicles[0]!, model: 'Accord Sport' }] }))).toEqual([]);
  });
});

describe('detectChanges — fields without v1 events', () => {
  it('ignores policyholder contact changes and driver changes', () => {
    const prev = basePolicy();
    const curr = basePolicy({
      policyholder: { ...prev.policyholder, email: 'new.address@example.com', phone: '+15550109999' },
      drivers: [...prev.drivers, { firstName: 'Casey', lastName: 'Rivera', dateOfBirth: '2009-03-03', licenseState: 'OH', relationship: 'CHILD' }],
    });
    expect(detectChanges(prev, curr)).toEqual([]);
  });

  it('orders a multi-change result deterministically: lifecycle, premium, coverage, vehicles', () => {
    const prev = basePolicy();
    const curr = basePolicy({
      status: 'CANCELLED',
      premium: { amountCents: 0, currency: 'USD' },
      vehicles: [],
      coverages: [prev.coverages[0]!],
    });
    expect(types(prev, curr)).toEqual(['POLICY_CANCELLED', 'PREMIUM_CHANGED', 'COVERAGE_CHANGED', 'VEHICLE_REMOVED']);
    // Same input → same output, every time.
    expect(detectChanges(prev, curr)).toEqual(detectChanges(structuredClone(prev), structuredClone(curr)));
  });
});
