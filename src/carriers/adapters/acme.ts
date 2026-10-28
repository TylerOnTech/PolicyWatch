import { z } from 'zod';
import {
  calendarDate,
  code,
  currency,
  dollarsToCents,
  email,
  finalizePolicy,
  mapCode,
  optionalCalendarDate,
  optionalDollarsToCents,
  optionalStateCode,
  phone,
  postalCode,
  requiredText,
  stateCode,
  text,
  vin,
  year,
} from '../../domain/normalize.js';
import {
  NORMALIZED_POLICY_SCHEMA_VERSION,
  type Coverage,
  type CoverageType,
  type DriverRelationship,
  type NormalizedPolicy,
  type PolicyStatus,
} from '../../domain/normalized-policy.js';
import { carrierRequest, classifyHttpStatus, parseJsonBody } from '../http.js';
import type { CarrierAdapter, FetchContext } from '../types.js';
import { looseScalar, normalizeOrThrow, optionalLoose, parseWithStatus } from './common.js';

/**
 * Acme Mutual — REST/JSON, camelCase, nested objects, money as decimal-dollar strings,
 * ISO calendar dates, API-key header auth.
 */
export const ACME_CARRIER_ID = 'acme';

const STATUS: Record<string, PolicyStatus> = {
  IN_FORCE: 'ACTIVE',
  ACTIVE: 'ACTIVE',
  PENDING_ISSUE: 'PENDING',
  CANCELLED: 'CANCELLED',
  CANCELED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

const LINE_OF_BUSINESS: Record<string, NormalizedPolicy['policyType']> = {
  PERSONAL_AUTO: 'AUTO',
};

const COVERAGE: Record<string, CoverageType> = {
  BI: 'BODILY_INJURY_LIABILITY',
  PD: 'PROPERTY_DAMAGE_LIABILITY',
  UMBI: 'UNINSURED_MOTORIST_BI',
  UIMBI: 'UNDERINSURED_MOTORIST_BI',
  MEDPAY: 'MEDICAL_PAYMENTS',
  PIP: 'PERSONAL_INJURY_PROTECTION',
  COLL: 'COLLISION',
  COMP: 'COMPREHENSIVE',
  RREIM: 'RENTAL_REIMBURSEMENT',
  TOW: 'ROADSIDE_ASSISTANCE',
};

const RELATIONSHIP: Record<string, DriverRelationship> = {
  SELF: 'NAMED_INSURED',
  SPOUSE: 'SPOUSE',
  CHILD: 'CHILD',
  OTHER: 'OTHER',
};

const AcmeCoverage = z.object({
  coverageCode: z.string(),
  limits: z.object({ perPerson: optionalLoose, perAccident: optionalLoose }).nullish(),
  deductible: optionalLoose,
});

export const AcmeResponseSchema = z.object({
  policy: z.object({
    policyNumber: z.string(),
    lineOfBusiness: z.string(),
    policyStatus: z.string(),
    term: z.object({ effectiveDate: z.string(), expirationDate: z.string() }),
    totalPremium: z.object({ amount: looseScalar, currencyCode: z.string() }),
    namedInsured: z.object({
      givenName: z.string(),
      familyName: z.string(),
      emailAddress: z.string().nullish(),
      phoneNumber: z.string().nullish(),
      mailingAddress: z.object({
        street1: z.string(),
        street2: z.string().nullish(),
        city: z.string(),
        stateCode: z.string(),
        zip: looseScalar,
      }),
    }),
    vehicles: z
      .array(
        z.object({
          vin: z.string(),
          modelYear: looseScalar,
          make: z.string(),
          model: z.string(),
          coverages: z.array(AcmeCoverage).nullish(),
        }),
      )
      .nullish(),
    drivers: z
      .array(
        z.object({
          givenName: z.string(),
          familyName: z.string(),
          birthDate: z.string().nullish(),
          licenseState: z.string().nullish(),
          relationToInsured: z.string().nullish(),
        }),
      )
      .nullish(),
    policyCoverages: z.array(AcmeCoverage).nullish(),
  }),
});

function toCoverage(raw: z.infer<typeof AcmeCoverage>, vehicleVin: string | null, path: string): Coverage {
  const carrierCode = code(raw.coverageCode) ?? '';
  return {
    type: COVERAGE[carrierCode] ?? 'OTHER',
    carrierCode: requiredText(carrierCode, `${path}.coverageCode`),
    vehicleVin,
    limitPerPersonCents: optionalDollarsToCents(raw.limits?.perPerson, `${path}.limits.perPerson`),
    limitPerOccurrenceCents: optionalDollarsToCents(raw.limits?.perAccident, `${path}.limits.perAccident`),
    deductibleCents: optionalDollarsToCents(raw.deductible, `${path}.deductible`),
  };
}

/** Pure: Acme response body (already JSON-parsed) → NormalizedPolicy v1. */
export function parseAcmePolicy(body: unknown, retrievedAt: Date): NormalizedPolicy {
  return normalizeOrThrow(ACME_CARRIER_ID, () => {
    const { policy: p } = AcmeResponseSchema.parse(body);
    const insured = p.namedInsured;
    const addr = insured.mailingAddress;
    const vehicles = p.vehicles ?? [];

    return finalizePolicy({
      schemaVersion: NORMALIZED_POLICY_SCHEMA_VERSION,
      carrierId: ACME_CARRIER_ID,
      externalPolicyId: requiredText(p.policyNumber, 'policy.policyNumber').toUpperCase(),
      policyholder: {
        firstName: requiredText(insured.givenName, 'namedInsured.givenName'),
        lastName: requiredText(insured.familyName, 'namedInsured.familyName'),
        email: email(insured.emailAddress),
        phone: phone(insured.phoneNumber),
        address: {
          line1: requiredText(addr.street1, 'mailingAddress.street1'),
          line2: text(addr.street2),
          city: requiredText(addr.city, 'mailingAddress.city'),
          state: stateCode(addr.stateCode, 'mailingAddress.stateCode'),
          postalCode: postalCode(addr.zip, 'mailingAddress.zip'),
          country: 'US',
        },
      },
      policyType: mapCode(p.lineOfBusiness, LINE_OF_BUSINESS, 'policy.lineOfBusiness'),
      status: mapCode(p.policyStatus, STATUS, 'policy.policyStatus'),
      effectiveDate: calendarDate(p.term.effectiveDate, 'term.effectiveDate'),
      expirationDate: calendarDate(p.term.expirationDate, 'term.expirationDate'),
      premium: {
        amountCents: dollarsToCents(p.totalPremium.amount, 'totalPremium.amount'),
        currency: currency(p.totalPremium.currencyCode, 'totalPremium.currencyCode'),
      },
      coverages: [
        ...(p.policyCoverages ?? []).map((c, i) => toCoverage(c, null, `policyCoverages.${i}`)),
        ...vehicles.flatMap((v, vi) => {
          const vehicleVin = vin(v.vin, `vehicles.${vi}.vin`);
          return (v.coverages ?? []).map((c, ci) => toCoverage(c, vehicleVin, `vehicles.${vi}.coverages.${ci}`));
        }),
      ],
      vehicles: vehicles.map((v, i) => ({
        vin: vin(v.vin, `vehicles.${i}.vin`),
        year: year(v.modelYear, `vehicles.${i}.modelYear`),
        make: requiredText(v.make, `vehicles.${i}.make`),
        model: requiredText(v.model, `vehicles.${i}.model`),
      })),
      drivers: (p.drivers ?? []).map((d, i) => ({
        firstName: requiredText(d.givenName, `drivers.${i}.givenName`),
        lastName: requiredText(d.familyName, `drivers.${i}.familyName`),
        dateOfBirth: optionalCalendarDate(d.birthDate, `drivers.${i}.birthDate`),
        licenseState: optionalStateCode(d.licenseState, `drivers.${i}.licenseState`),
        relationship: text(d.relationToInsured) ? mapCode(d.relationToInsured, RELATIONSHIP, `drivers.${i}.relationToInsured`) : null,
      })),
      retrievedAt: retrievedAt.toISOString(),
    });
  });
}

export function createAcmeAdapter(cfg: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxResponseBytes: number;
}): CarrierAdapter {
  return {
    carrierId: ACME_CARRIER_ID,
    displayName: 'Acme Mutual',
    async fetchPolicy(externalPolicyId: string, ctx: FetchContext = {}) {
      const res = await carrierRequest({
        url: `${cfg.baseUrl}/v2/policies/${encodeURIComponent(externalPolicyId)}`,
        headers: {
          accept: 'application/json',
          'x-api-key': cfg.apiKey,
          ...(ctx.correlationId ? { 'x-correlation-id': ctx.correlationId } : {}),
        },
        timeoutMs: cfg.timeoutMs,
        maxResponseBytes: cfg.maxResponseBytes,
        signal: ctx.signal,
      });
      const httpError = classifyHttpStatus(res);
      if (httpError) throw httpError;
      const policy = parseWithStatus(res.status, () => parseAcmePolicy(parseJsonBody(res), new Date()));
      return { policy, httpStatus: res.status };
    },
  };
}
