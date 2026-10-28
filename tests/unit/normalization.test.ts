import { describe, expect, it } from 'vitest';
import { parseAcmePolicy } from '../../src/carriers/adapters/acme.js';
import { parseBluebirdPolicy } from '../../src/carriers/adapters/bluebird.js';
import { parseCardinalPolicy } from '../../src/carriers/adapters/cardinal.js';
import { CarrierError } from '../../src/carriers/types.js';
import {
  calendarDate,
  dollarsToCents,
  phone,
  postalCode,
  snapshotHash,
  vin,
} from '../../src/domain/normalize.js';
import type { NormalizedPolicy } from '../../src/domain/normalized-policy.js';
import { renderAcme, renderBluebird, renderCardinal } from '../../src/simulators/carrier-sim/renderers.js';
import { seedPolicies, type SimPolicy } from '../../src/simulators/carrier-sim/store.js';

const T1 = new Date('2026-10-28T12:00:00.000Z');
const T2 = new Date('2026-10-28T13:00:00.000Z');

function parse(sim: SimPolicy, variant: number, at = T1): NormalizedPolicy {
  if (sim.carrierId === 'acme') return parseAcmePolicy(renderAcme(sim, variant), at);
  if (sim.carrierId === 'bluebird') return parseBluebirdPolicy(renderBluebird(sim, variant), at);
  return parseCardinalPolicy(renderCardinal(sim, variant), at);
}

function expectCarrierError(fn: () => unknown, category: CarrierError['category']) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CarrierError);
    expect((err as CarrierError).category).toBe(category);
    return err as CarrierError;
  }
  throw new Error(`expected CarrierError ${category}`);
}

describe('normalization primitives', () => {
  it.each([
    ['642.50', 64_250],
    ['642.5', 64_250],
    [642.5, 64_250],
    ['$1,204.00', 120_400],
    ['1204', 120_400],
    ['0.1', 10],
    ['0.105', 11], // half-up on the third decimal
    [100000, 10_000_000],
  ])('dollarsToCents(%j) = %d (no floating point drift)', (input, expected) => {
    expect(dollarsToCents(input, 'x')).toBe(expected);
  });

  it('rejects negative or garbage money', () => {
    expect(() => dollarsToCents('-5.00', 'x')).toThrow();
    expect(() => dollarsToCents('12.3.4', 'x')).toThrow();
  });

  it.each([
    ['2026-04-01', '2026-04-01'],
    ['2026-4-1', '2026-04-01'],
    ['04/01/2026', '2026-04-01'],
    ['4/1/2026', '2026-04-01'],
    ['20260401', '2026-04-01'],
    // Local calendar date is kept: converting to UTC would turn this into 2026-04-01 05:01Z (fine)
    // but 2026-03-31T23:30:00-05:00 would become April 1st.
    ['2026-03-31T23:30:00-05:00', '2026-03-31'],
    ['2026-04-01T00:01:00-0500', '2026-04-01'],
  ])('calendarDate(%s) = %s', (input, expected) => {
    expect(calendarDate(input, 'x')).toBe(expected);
  });

  it('rejects impossible dates', () => {
    expect(() => calendarDate('2026-02-30', 'x')).toThrow(/invalid calendar date/);
    expect(() => calendarDate('13/01/2026', 'x')).toThrow();
  });

  it('normalizes phones, postal codes and VINs', () => {
    expect(phone('(555) 010-2234')).toBe('+15550102234');
    expect(phone('+1 555 010 2234')).toBe('+15550102234');
    expect(phone('555.010.2234')).toBe('+15550102234');
    expect(phone('12')).toBeNull();
    expect(postalCode('787040001', 'x')).toBe('78704-0001');
    expect(postalCode('02134', 'x')).toBe('02134');
    expect(vin(' 1hgcv1f30ma000101 ', 'x')).toBe('1HGCV1F30MA000101');
    expect(() => vin('1HGCV1F30MA00010I', 'x')).toThrow(/VIN/); // I is not a VIN character
  });
});

describe.each(['acme', 'bluebird', 'cardinal'] as const)('%s adapter', (carrierId) => {
  const sims = seedPolicies().filter((p) => p.carrierId === carrierId);

  it.each(sims.map((s) => [s.policyNumber, s] as const))('normalizes %s into a valid NormalizedPolicy v1', (_n, sim) => {
    const p = parse(sim, 0);
    expect(p.schemaVersion).toBe('1.0');
    expect(p.carrierId).toBe(carrierId);
    expect(p.externalPolicyId).toBe(sim.policyNumber);
    expect(p.status).toBe(sim.status);
    expect(p.effectiveDate).toBe(sim.effectiveDate);
    expect(p.expirationDate).toBe(sim.expirationDate);
    expect(p.premium).toEqual({ amountCents: sim.premiumCents, currency: 'USD' });
    expect(p.vehicles.map((v) => v.vin).sort()).toEqual(sim.vehicles.map((v) => v.vin).sort());
    const expectedCoverages = sim.policyCoverages.length + sim.vehicles.reduce((n, v) => n + v.coverages.length, 0);
    expect(p.coverages).toHaveLength(expectedCoverages);
    expect(p.coverages.every((c) => c.type !== 'OTHER')).toBe(true);
    expect(p.policyholder.phone).toBe(`+1${sim.insured.phone}`);
    expect(p.retrievedAt).toBe(T1.toISOString());
  });

  it.each(sims.map((s) => [s.policyNumber, s] as const))(
    'produces the same content hash for cosmetically different responses (%s)',
    (_n, sim) => {
      const plain = parse(sim, 0, T1);
      const noisy = parse(sim, 1, T2);
      expect(noisy).toEqual({ ...plain, retrievedAt: T2.toISOString() });
      expect(snapshotHash(noisy)).toBe(snapshotHash(plain));
    },
  );

  it('produces a different hash when something material changes', () => {
    const sim = sims[0]!;
    expect(snapshotHash(parse({ ...sim, premiumCents: sim.premiumCents + 1 }, 0))).not.toBe(snapshotHash(parse(sim, 0)));
  });
});

describe('carrier-specific normalization', () => {
  const [acme] = seedPolicies();

  it('acme: maps a golden response exactly', () => {
    const p = parseAcmePolicy(renderAcme(acme!, 0), T1);
    expect(p.policyholder).toEqual({
      firstName: 'Jordan',
      lastName: 'Rivera',
      email: 'jordan.rivera@example.com',
      phone: '+15550102234',
      address: { line1: '1420 Maple Grove Ave', line2: 'Apt 3B', city: 'Columbus', state: 'OH', postalCode: '43215', country: 'US' },
    });
    expect(p.coverages.find((c) => c.type === 'BODILY_INJURY_LIABILITY')).toEqual({
      type: 'BODILY_INJURY_LIABILITY',
      carrierCode: 'BI',
      vehicleVin: null,
      limitPerPersonCents: 10_000_000,
      limitPerOccurrenceCents: 30_000_000,
      deductibleCents: null,
    });
    expect(p.drivers).toEqual([
      { firstName: 'Jordan', lastName: 'Rivera', dateOfBirth: '1990-05-17', licenseState: 'OH', relationship: 'NAMED_INSURED' },
    ]);
  });

  it('acme: unknown status is rejected, never guessed', () => {
    const body = renderAcme(acme!, 0);
    body.policy.policyStatus = 'SUSPENDED_FOR_REVIEW' as never;
    expectCarrierError(() => parseAcmePolicy(body, T1), 'INVALID_CARRIER_RESPONSE');
  });

  it('acme: unknown coverage codes are preserved as OTHER with the carrier code', () => {
    const body = renderAcme(acme!, 0);
    body.policy.policyCoverages.push({ coverageCode: 'GAP', limits: null, deductible: null } as never);
    const p = parseAcmePolicy(body, T1);
    expect(p.coverages.find((c) => c.carrierCode === 'GAP')).toMatchObject({ type: 'OTHER', vehicleVin: null });
  });

  it('acme: structurally invalid responses are classified without leaking values', () => {
    const err = expectCarrierError(() => parseAcmePolicy({ policy: { policyNumber: 'X' } }, T1), 'INVALID_CARRIER_RESPONSE');
    expect(err.message).toContain('policy.');
  });

  it('bluebird: splits full names and keeps the local term date despite the UTC offset', () => {
    const sim = seedPolicies().find((p) => p.policyNumber === 'BB-55120')!;
    const p = parseBluebirdPolicy(renderBluebird(sim, 0), T1);
    expect(p.policyholder.firstName).toBe('SAMIR');
    expect(p.policyholder.lastName).toBe('PATEL');
    expect(p.effectiveDate).toBe('2026-03-15');
    expect(p.policyholder.address.postalCode).toBe('78704-0001');
  });

  it('bluebird: "processing" envelope means data unavailable, not a status change', () => {
    const err = expectCarrierError(
      () => parseBluebirdPolicy({ status: 'processing', data: null, retry_after_seconds: 30 }, T1),
      'CARRIER_DATA_UNAVAILABLE',
    );
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.transient).toBe(true);
  });

  it('cardinal: keeps leading zeros in postal codes (XML values are never coerced to numbers)', () => {
    const sim = seedPolicies().find((p) => p.policyNumber === 'CC-7902-2026')!;
    expect(parseCardinalPolicy(renderCardinal(sim, 0), T1).policyholder.address.postalCode).toBe('02134');
  });

  it('cardinal: HTTP-200 NOT_FOUND and DATA_UNAVAILABLE statuses are classified', () => {
    const status = (cd: string) =>
      `<?xml version="1.0"?><PolicyInquiryRs><MsgStatus><StatusCd>${cd}</StatusCd></MsgStatus></PolicyInquiryRs>`;
    expectCarrierError(() => parseCardinalPolicy(status('NOT_FOUND'), T1), 'POLICY_NOT_FOUND');
    expectCarrierError(() => parseCardinalPolicy(status('DATA_UNAVAILABLE'), T1), 'CARRIER_DATA_UNAVAILABLE');
  });

  it('cardinal: rejects malformed XML and any DTD (entity-expansion / XXE defense)', () => {
    expectCarrierError(() => parseCardinalPolicy('<PolicyInquiryRs><MsgStatus>', T1), 'INVALID_CARRIER_RESPONSE');
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><PolicyInquiryRs>&x;</PolicyInquiryRs>`;
    const err = expectCarrierError(() => parseCardinalPolicy(xxe, T1), 'INVALID_CARRIER_RESPONSE');
    expect(err.message).toMatch(/DTD/);
  });
});
