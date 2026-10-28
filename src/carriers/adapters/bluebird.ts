import { z } from 'zod';
import {
  calendarDate,
  code,
  currency,
  email,
  finalizePolicy,
  integerCents,
  mapCode,
  optionalCalendarDate,
  optionalIntegerCents,
  optionalStateCode,
  phone,
  postalCode,
  requiredText,
  splitFullName,
  stateCode,
  text,
  vin,
  year,
} from '../../domain/normalize.js';
import {
  NORMALIZED_POLICY_SCHEMA_VERSION,
  type CoverageType,
  type DriverRelationship,
  type NormalizedPolicy,
  type PolicyStatus,
} from '../../domain/normalized-policy.js';
import { carrierRequest, classifyHttpStatus, parseJsonBody } from '../http.js';
import { CarrierError, type CarrierAdapter, type FetchContext } from '../types.js';
import { looseScalar, normalizeOrThrow, optionalLoose, parseWithStatus } from './common.js';

/**
 * Bluebird Insurance — REST/JSON, snake_case, flat records, integer cents, ISO date-times with
 * carrier-local offsets, full names in a single field, bearer-token auth. Returns an envelope whose
 * `status: "processing"` means "no trustworthy data right now" even though HTTP is 200.
 */
export const BLUEBIRD_CARRIER_ID = 'bluebird';

const STATUS: Record<string, PolicyStatus> = {
  ACTIVE: 'ACTIVE',
  PENDING: 'PENDING',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

const PRODUCT: Record<string, NormalizedPolicy['policyType']> = { AUTO: 'AUTO', PERSONAL_AUTO: 'AUTO' };

const COVERAGE: Record<string, CoverageType> = {
  BODILY_INJURY: 'BODILY_INJURY_LIABILITY',
  PROPERTY_DAMAGE: 'PROPERTY_DAMAGE_LIABILITY',
  UNINSURED_MOTORIST: 'UNINSURED_MOTORIST_BI',
  UNDERINSURED_MOTORIST: 'UNDERINSURED_MOTORIST_BI',
  MEDICAL_PAYMENTS: 'MEDICAL_PAYMENTS',
  PIP: 'PERSONAL_INJURY_PROTECTION',
  COLLISION: 'COLLISION',
  COMPREHENSIVE: 'COMPREHENSIVE',
  RENTAL: 'RENTAL_REIMBURSEMENT',
  ROADSIDE: 'ROADSIDE_ASSISTANCE',
};

const RELATIONSHIP: Record<string, DriverRelationship> = {
  PRIMARY: 'NAMED_INSURED',
  SPOUSE: 'SPOUSE',
  DEPENDENT: 'CHILD',
  OTHER: 'OTHER',
};

export const BluebirdEnvelopeSchema = z.object({
  status: z.string(),
  retry_after_seconds: z.number().nullish(),
  data: z.unknown().nullish(),
});

export const BluebirdPolicySchema = z.object({
  policy_id: z.string(),
  product_code: z.string(),
  policy_state: z.string(),
  term_start: z.string(),
  term_end: z.string(),
  premium_cents: looseScalar,
  currency: z.string(),
  insured: z.object({
    full_name: z.string(),
    email: z.string().nullish(),
    phone_e164: z.string().nullish(),
    addr_line1: z.string(),
    addr_line2: z.string().nullish(),
    addr_city: z.string(),
    addr_state: z.string(),
    addr_zip: looseScalar,
  }),
  units: z
    .array(
      z.object({
        unit_type: z.string(),
        vin: z.string().nullish(),
        model_year: looseScalar.nullish(),
        make: z.string().nullish(),
        model: z.string().nullish(),
      }),
    )
    .nullish(),
  operators: z
    .array(
      z.object({
        name: z.string(),
        dob: z.string().nullish(),
        license_state: z.string().nullish(),
        relationship: z.string().nullish(),
      }),
    )
    .nullish(),
  coverage_lines: z
    .array(
      z.object({
        type: z.string(),
        unit_vin: z.string().nullish(),
        per_person_limit_cents: optionalLoose,
        per_accident_limit_cents: optionalLoose,
        deductible_cents: optionalLoose,
      }),
    )
    .nullish(),
});

/** Pure: Bluebird envelope (already JSON-parsed) → NormalizedPolicy v1. */
export function parseBluebirdPolicy(body: unknown, retrievedAt: Date): NormalizedPolicy {
  return normalizeOrThrow(BLUEBIRD_CARRIER_ID, () => {
    const envelope = BluebirdEnvelopeSchema.parse(body);
    const envelopeStatus = code(envelope.status);
    if (envelopeStatus === 'PROCESSING' || envelopeStatus === 'UNAVAILABLE') {
      throw new CarrierError(
        'CARRIER_DATA_UNAVAILABLE',
        'Bluebird reported the policy record is temporarily unavailable',
        200,
        envelope.retry_after_seconds ?? undefined,
      );
    }
    if (envelopeStatus !== 'OK' || envelope.data === null || envelope.data === undefined) {
      throw new CarrierError('INVALID_CARRIER_RESPONSE', `Bluebird envelope status '${envelopeStatus ?? 'missing'}' has no policy data`, 200);
    }

    const p = BluebirdPolicySchema.parse(envelope.data);
    const ins = p.insured;
    const name = splitFullName(ins.full_name, 'insured.full_name');
    const vehicles = (p.units ?? []).filter((u) => code(u.unit_type) === 'VEHICLE');

    return finalizePolicy({
      schemaVersion: NORMALIZED_POLICY_SCHEMA_VERSION,
      carrierId: BLUEBIRD_CARRIER_ID,
      externalPolicyId: requiredText(p.policy_id, 'policy_id').toUpperCase(),
      policyholder: {
        ...name,
        email: email(ins.email),
        phone: phone(ins.phone_e164),
        address: {
          line1: requiredText(ins.addr_line1, 'insured.addr_line1'),
          line2: text(ins.addr_line2),
          city: requiredText(ins.addr_city, 'insured.addr_city'),
          state: stateCode(ins.addr_state, 'insured.addr_state'),
          postalCode: postalCode(ins.addr_zip, 'insured.addr_zip'),
          country: 'US',
        },
      },
      policyType: mapCode(p.product_code, PRODUCT, 'product_code'),
      status: mapCode(p.policy_state, STATUS, 'policy_state'),
      effectiveDate: calendarDate(p.term_start, 'term_start'),
      expirationDate: calendarDate(p.term_end, 'term_end'),
      premium: {
        amountCents: integerCents(p.premium_cents, 'premium_cents'),
        currency: currency(p.currency, 'currency'),
      },
      coverages: (p.coverage_lines ?? []).map((c, i) => {
        const carrierCode = code(c.type) ?? '';
        return {
          type: COVERAGE[carrierCode] ?? 'OTHER',
          carrierCode: requiredText(carrierCode, `coverage_lines.${i}.type`),
          vehicleVin: text(c.unit_vin) ? vin(c.unit_vin, `coverage_lines.${i}.unit_vin`) : null,
          limitPerPersonCents: optionalIntegerCents(c.per_person_limit_cents, `coverage_lines.${i}.per_person_limit_cents`),
          limitPerOccurrenceCents: optionalIntegerCents(c.per_accident_limit_cents, `coverage_lines.${i}.per_accident_limit_cents`),
          deductibleCents: optionalIntegerCents(c.deductible_cents, `coverage_lines.${i}.deductible_cents`),
        };
      }),
      vehicles: vehicles.map((u, i) => ({
        vin: vin(u.vin, `units.${i}.vin`),
        year: year(u.model_year, `units.${i}.model_year`),
        make: requiredText(u.make, `units.${i}.make`),
        model: requiredText(u.model, `units.${i}.model`),
      })),
      drivers: (p.operators ?? []).map((o, i) => ({
        ...splitFullName(o.name, `operators.${i}.name`),
        dateOfBirth: optionalCalendarDate(o.dob, `operators.${i}.dob`),
        licenseState: optionalStateCode(o.license_state, `operators.${i}.license_state`),
        relationship: text(o.relationship) ? mapCode(o.relationship, RELATIONSHIP, `operators.${i}.relationship`) : null,
      })),
      retrievedAt: retrievedAt.toISOString(),
    });
  });
}

export function createBluebirdAdapter(cfg: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  maxResponseBytes: number;
}): CarrierAdapter {
  return {
    carrierId: BLUEBIRD_CARRIER_ID,
    displayName: 'Bluebird Insurance',
    async fetchPolicy(externalPolicyId: string, ctx: FetchContext = {}) {
      const url = new URL(`${cfg.baseUrl}/api/v1/policy`);
      url.searchParams.set('policy_id', externalPolicyId);
      const res = await carrierRequest({
        url: url.toString(),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${cfg.token}`,
          ...(ctx.correlationId ? { 'x-request-id': ctx.correlationId } : {}),
        },
        timeoutMs: cfg.timeoutMs,
        maxResponseBytes: cfg.maxResponseBytes,
        signal: ctx.signal,
      });
      const httpError = classifyHttpStatus(res);
      if (httpError) throw httpError;
      const policy = parseWithStatus(res.status, () => parseBluebirdPolicy(parseJsonBody(res), new Date()));
      return { policy, httpStatus: res.status };
    },
  };
}
