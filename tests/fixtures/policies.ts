import type { NormalizedPolicy } from '../../src/domain/normalized-policy.js';

/** A fully-populated synthetic NormalizedPolicy used as the "previous" side in differ tests. */
export function basePolicy(overrides: Partial<NormalizedPolicy> = {}): NormalizedPolicy {
  return {
    schemaVersion: '1.0',
    carrierId: 'acme',
    externalPolicyId: 'ACM-AUTO-100234',
    policyholder: {
      firstName: 'Jordan',
      lastName: 'Rivera',
      email: 'jordan.rivera@example.com',
      phone: '+15550102234',
      address: { line1: '1420 Maple Grove Ave', line2: 'Apt 3B', city: 'Columbus', state: 'OH', postalCode: '43215', country: 'US' },
    },
    policyType: 'AUTO',
    status: 'ACTIVE',
    effectiveDate: '2026-05-01',
    expirationDate: '2026-11-01',
    premium: { amountCents: 64_250, currency: 'USD' },
    coverages: [
      {
        type: 'BODILY_INJURY_LIABILITY',
        carrierCode: 'BI',
        vehicleVin: null,
        limitPerPersonCents: 10_000_000,
        limitPerOccurrenceCents: 30_000_000,
        deductibleCents: null,
      },
      {
        type: 'PROPERTY_DAMAGE_LIABILITY',
        carrierCode: 'PD',
        vehicleVin: null,
        limitPerPersonCents: null,
        limitPerOccurrenceCents: 10_000_000,
        deductibleCents: null,
      },
      {
        type: 'COLLISION',
        carrierCode: 'COLL',
        vehicleVin: '1HGCV1F30MA000101',
        limitPerPersonCents: null,
        limitPerOccurrenceCents: null,
        deductibleCents: 50_000,
      },
    ],
    vehicles: [{ vin: '1HGCV1F30MA000101', year: 2021, make: 'Honda', model: 'Accord' }],
    drivers: [{ firstName: 'Jordan', lastName: 'Rivera', dateOfBirth: '1990-05-17', licenseState: 'OH', relationship: 'NAMED_INSURED' }],
    retrievedAt: '2026-10-28T12:00:00.000Z',
    ...overrides,
  };
}
