import { z } from 'zod';

/**
 * NormalizedPolicy v1 — the carrier-agnostic contract every adapter must produce.
 * Documented in docs/normalized-policy-v1.md. Any breaking change requires a new schemaVersion.
 */
export const NORMALIZED_POLICY_SCHEMA_VERSION = '1.0' as const;

export const POLICY_STATUSES = ['ACTIVE', 'PENDING', 'CANCELLED', 'EXPIRED'] as const;
export const POLICY_TYPES = ['AUTO', 'HOME', 'RENTERS', 'UMBRELLA'] as const;
export const COVERAGE_TYPES = [
  'BODILY_INJURY_LIABILITY',
  'PROPERTY_DAMAGE_LIABILITY',
  'UNINSURED_MOTORIST_BI',
  'UNDERINSURED_MOTORIST_BI',
  'MEDICAL_PAYMENTS',
  'PERSONAL_INJURY_PROTECTION',
  'COLLISION',
  'COMPREHENSIVE',
  'RENTAL_REIMBURSEMENT',
  'ROADSIDE_ASSISTANCE',
  'OTHER',
] as const;
export const DRIVER_RELATIONSHIPS = ['NAMED_INSURED', 'SPOUSE', 'CHILD', 'OTHER'] as const;

export type PolicyStatus = (typeof POLICY_STATUSES)[number];
export type PolicyType = (typeof POLICY_TYPES)[number];
export type CoverageType = (typeof COVERAGE_TYPES)[number];
export type DriverRelationship = (typeof DRIVER_RELATIONSHIPS)[number];

const isoDate = z.iso.date();
const cents = z.number().int().nonnegative();
const nullableCents = cents.nullable();

export const AddressSchema = z.strictObject({
  line1: z.string().min(1),
  line2: z.string().min(1).nullable(),
  city: z.string().min(1),
  state: z.string().regex(/^[A-Z]{2}$/),
  postalCode: z.string().regex(/^\d{5}(-\d{4})?$/),
  country: z.string().regex(/^[A-Z]{2}$/),
});

export const PolicyholderSchema = z.strictObject({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.email().nullable(),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'E.164')
    .nullable(),
  address: AddressSchema,
});

export const PremiumSchema = z.strictObject({
  amountCents: cents,
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export const CoverageSchema = z.strictObject({
  type: z.enum(COVERAGE_TYPES),
  /** Carrier's own code, upper-cased. Kept so OTHER coverages remain distinguishable. */
  carrierCode: z.string().min(1),
  /** null for policy-level coverages (e.g. liability); the VIN for vehicle-level coverages. */
  vehicleVin: z.string().regex(VIN_PATTERN).nullable(),
  limitPerPersonCents: nullableCents,
  limitPerOccurrenceCents: nullableCents,
  deductibleCents: nullableCents,
});

export const VehicleSchema = z.strictObject({
  vin: z.string().regex(VIN_PATTERN),
  year: z.number().int().min(1900).max(2100),
  make: z.string().min(1),
  model: z.string().min(1),
});

export const DriverSchema = z.strictObject({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: isoDate.nullable(),
  licenseState: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  relationship: z.enum(DRIVER_RELATIONSHIPS).nullable(),
});

export const NormalizedPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(NORMALIZED_POLICY_SCHEMA_VERSION),
    carrierId: z.string().min(1),
    externalPolicyId: z.string().min(1),
    policyholder: PolicyholderSchema,
    policyType: z.enum(POLICY_TYPES),
    status: z.enum(POLICY_STATUSES),
    effectiveDate: isoDate,
    expirationDate: isoDate,
    premium: PremiumSchema,
    coverages: z.array(CoverageSchema),
    vehicles: z.array(VehicleSchema),
    drivers: z.array(DriverSchema),
    retrievedAt: z.iso.datetime(),
  })
  .superRefine((p, ctx) => {
    if (p.expirationDate <= p.effectiveDate) {
      ctx.addIssue({ code: 'custom', path: ['expirationDate'], message: 'must be after effectiveDate' });
    }
    const vins = new Set(p.vehicles.map((v) => v.vin));
    if (vins.size !== p.vehicles.length) {
      ctx.addIssue({ code: 'custom', path: ['vehicles'], message: 'duplicate VIN' });
    }
    p.coverages.forEach((c, i) => {
      if (c.vehicleVin !== null && !vins.has(c.vehicleVin)) {
        ctx.addIssue({ code: 'custom', path: ['coverages', i, 'vehicleVin'], message: 'references unknown vehicle' });
      }
    });
  });

export type NormalizedPolicy = z.infer<typeof NormalizedPolicySchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Vehicle = z.infer<typeof VehicleSchema>;
export type Driver = z.infer<typeof DriverSchema>;
export type Premium = z.infer<typeof PremiumSchema>;
