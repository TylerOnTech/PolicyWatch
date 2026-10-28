/**
 * In-memory "system of record" for the simulated carriers. Policies are stored in one internal shape
 * and rendered into each carrier's wire format by renderers.ts. All data is synthetic: names are
 * invented, emails use reserved example.* domains, phone numbers use the fictional 555-01xx range,
 * and VINs are fabricated.
 */
export type SimCarrierId = 'acme' | 'bluebird' | 'cardinal';
export type SimStatus = 'ACTIVE' | 'PENDING' | 'CANCELLED' | 'EXPIRED';
export type SimCoverageType =
  | 'BODILY_INJURY_LIABILITY'
  | 'PROPERTY_DAMAGE_LIABILITY'
  | 'UNINSURED_MOTORIST_BI'
  | 'MEDICAL_PAYMENTS'
  | 'COLLISION'
  | 'COMPREHENSIVE'
  | 'RENTAL_REIMBURSEMENT'
  | 'ROADSIDE_ASSISTANCE';

export interface SimCoverage {
  type: SimCoverageType;
  perPersonCents?: number;
  perOccurrenceCents?: number;
  deductibleCents?: number;
}

export interface SimVehicle {
  vin: string;
  year: number;
  make: string;
  model: string;
  coverages: SimCoverage[];
}

export interface SimDriver {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  licenseState: string;
  relationship: 'NAMED_INSURED' | 'SPOUSE' | 'CHILD' | 'OTHER';
}

export interface SimPolicy {
  carrierId: SimCarrierId;
  policyNumber: string;
  status: SimStatus;
  effectiveDate: string;
  expirationDate: string;
  premiumCents: number;
  insured: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string; // 10 digits
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
  };
  vehicles: SimVehicle[];
  drivers: SimDriver[];
  policyCoverages: SimCoverage[];
}

export type FaultMode =
  | 'none'
  | 'http_500'
  | 'http_503'
  | 'timeout'
  | 'rate_limited'
  | 'data_unavailable'
  | 'malformed'
  | 'not_found'
  | 'auth_error';

export interface Fault {
  mode: FaultMode;
  /** Number of requests the fault applies to; null = until cleared. */
  remaining: number | null;
}

const liability = (perPerson: number, perAccident: number, property: number): SimCoverage[] => [
  { type: 'BODILY_INJURY_LIABILITY', perPersonCents: perPerson * 100, perOccurrenceCents: perAccident * 100 },
  { type: 'PROPERTY_DAMAGE_LIABILITY', perOccurrenceCents: property * 100 },
];

const physical = (collision: number, comprehensive: number): SimCoverage[] => [
  { type: 'COLLISION', deductibleCents: collision * 100 },
  { type: 'COMPREHENSIVE', deductibleCents: comprehensive * 100 },
];

export function seedPolicies(): SimPolicy[] {
  return [
    {
      carrierId: 'acme',
      policyNumber: 'ACM-AUTO-100234',
      status: 'ACTIVE',
      effectiveDate: '2026-05-01',
      expirationDate: '2026-11-01',
      premiumCents: 64_250,
      insured: {
        firstName: 'Jordan',
        lastName: 'Rivera',
        email: 'jordan.rivera@example.com',
        phone: '5550102234',
        line1: '1420 Maple Grove Ave',
        line2: 'Apt 3B',
        city: 'Columbus',
        state: 'OH',
        postalCode: '43215',
      },
      vehicles: [
        { vin: '1HGCV1F30MA000101', year: 2021, make: 'Honda', model: 'Accord', coverages: physical(500, 250) },
      ],
      drivers: [
        { firstName: 'Jordan', lastName: 'Rivera', dateOfBirth: '1990-05-17', licenseState: 'OH', relationship: 'NAMED_INSURED' },
      ],
      policyCoverages: [
        ...liability(100_000, 300_000, 100_000),
        { type: 'UNINSURED_MOTORIST_BI', perPersonCents: 10_000_000, perOccurrenceCents: 30_000_000 },
        { type: 'MEDICAL_PAYMENTS', perPersonCents: 500_000 },
      ],
    },
    {
      carrierId: 'acme',
      policyNumber: 'ACM-AUTO-100871',
      status: 'ACTIVE',
      effectiveDate: '2026-02-15',
      expirationDate: '2027-02-15',
      premiumCents: 182_000,
      insured: {
        firstName: 'Priya',
        lastName: 'Natarajan',
        email: 'priya.natarajan@example.org',
        phone: '5550107781',
        line1: '88 Lakeshore Terrace',
        line2: null,
        city: 'Madison',
        state: 'WI',
        postalCode: '53703',
      },
      vehicles: [
        { vin: '5YJ3E1EA7PF000202', year: 2023, make: 'Tesla', model: 'Model 3', coverages: physical(1000, 500) },
        { vin: '2T3P1RFV8LC000203', year: 2020, make: 'Toyota', model: 'RAV4', coverages: physical(500, 500) },
      ],
      drivers: [
        { firstName: 'Priya', lastName: 'Natarajan', dateOfBirth: '1986-09-02', licenseState: 'WI', relationship: 'NAMED_INSURED' },
        { firstName: 'Arun', lastName: 'Natarajan', dateOfBirth: '1985-01-23', licenseState: 'WI', relationship: 'SPOUSE' },
      ],
      policyCoverages: liability(250_000, 500_000, 100_000),
    },
    {
      carrierId: 'bluebird',
      policyNumber: 'BB-55120',
      status: 'ACTIVE',
      effectiveDate: '2026-03-15',
      expirationDate: '2027-03-15',
      premiumCents: 118_200,
      insured: {
        firstName: 'Samir',
        lastName: 'Patel',
        email: 'samir.patel@example.net',
        phone: '5550104477',
        line1: '2201 Bluebonnet Ln',
        line2: null,
        city: 'Austin',
        state: 'TX',
        postalCode: '787040001',
      },
      vehicles: [
        { vin: '4T1B11HK5KU000301', year: 2019, make: 'Toyota', model: 'Camry', coverages: physical(1000, 500) },
      ],
      drivers: [
        { firstName: 'Samir', lastName: 'Patel', dateOfBirth: '1985-11-02', licenseState: 'TX', relationship: 'NAMED_INSURED' },
      ],
      policyCoverages: [
        ...liability(50_000, 100_000, 50_000),
        { type: 'ROADSIDE_ASSISTANCE' },
      ],
    },
    {
      carrierId: 'bluebird',
      policyNumber: 'BB-55388',
      status: 'PENDING',
      effectiveDate: '2026-11-01',
      expirationDate: '2027-05-01',
      premiumCents: 74_400,
      insured: {
        firstName: 'Maria',
        lastName: 'Gonzalez',
        email: 'maria.gonzalez@example.net',
        phone: '5550106612',
        line1: '415 Desert Willow Rd',
        line2: 'Unit 12',
        city: 'Tucson',
        state: 'AZ',
        postalCode: '85719',
      },
      vehicles: [
        { vin: 'JM3KFBCM4L0000402', year: 2020, make: 'Mazda', model: 'CX-5', coverages: physical(500, 250) },
      ],
      drivers: [
        { firstName: 'Maria', lastName: 'Gonzalez', dateOfBirth: '1993-04-28', licenseState: 'AZ', relationship: 'NAMED_INSURED' },
      ],
      policyCoverages: liability(25_000, 50_000, 25_000),
    },
    {
      carrierId: 'cardinal',
      policyNumber: 'CC-7781-2026',
      status: 'ACTIVE',
      effectiveDate: '2026-04-01',
      expirationDate: '2027-04-01',
      premiumCents: 120_400,
      insured: {
        firstName: 'Avery',
        lastName: 'Chen',
        email: 'avery.chen@example.com',
        phone: '5550109921',
        line1: '730 Pike Street',
        line2: null,
        city: 'Seattle',
        state: 'WA',
        postalCode: '98101',
      },
      vehicles: [
        { vin: '4S4BTANC5N3000501', year: 2022, make: 'Subaru', model: 'Outback', coverages: physical(1000, 500) },
        { vin: '5J6RW2H59GL000502', year: 2016, make: 'Honda', model: 'CR-V', coverages: physical(500, 250) },
      ],
      drivers: [
        { firstName: 'Avery', lastName: 'Chen', dateOfBirth: '1992-08-09', licenseState: 'WA', relationship: 'NAMED_INSURED' },
        { firstName: 'Riley', lastName: 'Chen', dateOfBirth: '2008-06-14', licenseState: 'WA', relationship: 'CHILD' },
      ],
      policyCoverages: [
        ...liability(250_000, 500_000, 250_000),
        { type: 'RENTAL_REIMBURSEMENT', perOccurrenceCents: 90_000 },
      ],
    },
    {
      carrierId: 'cardinal',
      policyNumber: 'CC-7902-2026',
      status: 'EXPIRED',
      effectiveDate: '2026-01-10',
      expirationDate: '2026-07-10',
      premiumCents: 58_800,
      insured: {
        firstName: 'Dana',
        lastName: 'Okafor',
        email: 'dana.okafor@example.org',
        phone: '5550103350',
        line1: '19 Harbor View Dr',
        line2: null,
        city: 'Boston',
        state: 'MA',
        postalCode: '02134',
      },
      vehicles: [
        { vin: '3VWC57BU1KM000601', year: 2019, make: 'Volkswagen', model: 'Jetta', coverages: physical(500, 500) },
      ],
      drivers: [
        { firstName: 'Dana', lastName: 'Okafor', dateOfBirth: '1979-12-30', licenseState: 'MA', relationship: 'NAMED_INSURED' },
      ],
      policyCoverages: liability(20_000, 40_000, 5_000),
    },
  ];
}

const key = (carrierId: string, policyNumber: string) => `${carrierId}:${policyNumber.toUpperCase()}`;

export class SimStore {
  private policies = new Map<string, SimPolicy>();
  private faults = new Map<string, Fault>();
  private requestCounts = new Map<string, number>();
  /** When on, responses alternate between cosmetically different but equivalent formats. */
  noise = false;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.policies = new Map(seedPolicies().map((p) => [key(p.carrierId, p.policyNumber), p]));
    this.faults.clear();
    this.requestCounts.clear();
    this.noise = false;
  }

  list(): SimPolicy[] {
    return [...this.policies.values()];
  }

  get(carrierId: string, policyNumber: string): SimPolicy | undefined {
    return this.policies.get(key(carrierId, policyNumber));
  }

  put(policy: SimPolicy): void {
    this.policies.set(key(policy.carrierId, policy.policyNumber), policy);
  }

  /** Monotonic counter per policy, used to vary formatting between responses when noise is on. */
  nextVariant(carrierId: string, policyNumber: string): number {
    const k = key(carrierId, policyNumber);
    const n = (this.requestCounts.get(k) ?? 0) + 1;
    this.requestCounts.set(k, n);
    return this.noise ? n : 0;
  }

  setFault(carrierId: string, fault: Fault): void {
    if (fault.mode === 'none') this.faults.delete(carrierId);
    else this.faults.set(carrierId, fault);
  }

  getFaults(): Record<string, Fault> {
    return Object.fromEntries(this.faults);
  }

  /** Returns the active fault for a carrier and consumes one use of it. */
  takeFault(carrierId: string): FaultMode {
    const fault = this.faults.get(carrierId);
    if (!fault) return 'none';
    if (fault.remaining !== null) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) this.faults.delete(carrierId);
    }
    return fault.mode;
  }
}

function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return date.toISOString().slice(0, 10);
}

export interface SimMutation {
  status?: SimStatus;
  premiumCents?: number;
  addVehicle?: Omit<SimVehicle, 'coverages'> & { coverages?: SimCoverage[] };
  removeVehicleVin?: string;
  setCoverage?: SimCoverage & { vehicleVin?: string };
  removeCoverage?: { type: SimCoverageType; vehicleVin?: string };
  renew?: { termMonths?: number; premiumCents?: number };
  insuredEmail?: string;
}

/** Applies a carrier-agnostic mutation (what an underwriter or billing system would do). */
export function applyMutation(policy: SimPolicy, m: SimMutation): SimPolicy {
  const next: SimPolicy = structuredClone(policy);
  if (m.status) next.status = m.status;
  if (m.premiumCents !== undefined) next.premiumCents = m.premiumCents;
  if (m.insuredEmail) next.insured.email = m.insuredEmail;
  if (m.addVehicle) {
    next.vehicles.push({ ...m.addVehicle, coverages: m.addVehicle.coverages ?? physical(500, 500) });
  }
  if (m.removeVehicleVin) next.vehicles = next.vehicles.filter((v) => v.vin !== m.removeVehicleVin);
  const coverageList = (vin?: string) => (vin ? next.vehicles.find((v) => v.vin === vin)?.coverages : next.policyCoverages);
  if (m.setCoverage) {
    const { vehicleVin, ...coverage } = m.setCoverage;
    const list = coverageList(vehicleVin);
    if (list) {
      const idx = list.findIndex((c) => c.type === coverage.type);
      if (idx >= 0) list[idx] = coverage;
      else list.push(coverage);
    }
  }
  if (m.removeCoverage) {
    const list = coverageList(m.removeCoverage.vehicleVin);
    if (list) {
      const idx = list.findIndex((c) => c.type === m.removeCoverage!.type);
      if (idx >= 0) list.splice(idx, 1);
    }
  }
  if (m.renew) {
    const months = m.renew.termMonths ?? 6;
    next.effectiveDate = policy.expirationDate;
    next.expirationDate = addMonths(policy.expirationDate, months);
    next.status = 'ACTIVE';
    if (m.renew.premiumCents !== undefined) next.premiumCents = m.renew.premiumCents;
  }
  return next;
}
