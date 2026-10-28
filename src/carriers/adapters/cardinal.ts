import { XMLParser, XMLValidator } from 'fast-xml-parser';
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
import { carrierRequest, classifyHttpStatus } from '../http.js';
import { CarrierError, type CarrierAdapter, type FetchContext } from '../types.js';
import { normalizeOrThrow, parseWithStatus } from './common.js';

/**
 * Cardinal Casualty — ACORD-inspired XML over HTTP POST with basic auth. Single-letter status codes,
 * MM/DD/YYYY dates, formatted dollar amounts ("$1,204.00"), and SOAP-style "HTTP 200 with an error
 * status" responses for not-found and maintenance windows.
 */
export const CARDINAL_CARRIER_ID = 'cardinal';

const STATUS: Record<string, PolicyStatus> = { A: 'ACTIVE', P: 'PENDING', C: 'CANCELLED', E: 'EXPIRED' };
const LOB: Record<string, NormalizedPolicy['policyType']> = { AUTOP: 'AUTO' };
const COVERAGE: Record<string, CoverageType> = {
  BI: 'BODILY_INJURY_LIABILITY',
  PD: 'PROPERTY_DAMAGE_LIABILITY',
  UM: 'UNINSURED_MOTORIST_BI',
  UIM: 'UNDERINSURED_MOTORIST_BI',
  MEDPM: 'MEDICAL_PAYMENTS',
  PIP: 'PERSONAL_INJURY_PROTECTION',
  COLL: 'COLLISION',
  COMP: 'COMPREHENSIVE',
  RREIM: 'RENTAL_REIMBURSEMENT',
  TL: 'ROADSIDE_ASSISTANCE',
};
const RELATIONSHIP: Record<string, DriverRelationship> = { IN: 'NAMED_INSURED', SP: 'SPOUSE', CH: 'CHILD', OT: 'OTHER' };

const REPEATED = new Set(['PersVeh', 'PersDriver', 'Coverage', 'Limit']);

const parser = new XMLParser({
  ignoreAttributes: true,
  // Keep every value as a string: "02134" must not become the number 2134.
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => REPEATED.has(name),
});

const str = z.string();
const optStr = z.string().nullish();

const XmlCoverage = z.object({
  CoverageCd: str,
  Limit: z.array(z.object({ FormatInteger: str, LimitAppliesToCd: str })).nullish(),
  Deductible: z.object({ Amt: str }).nullish(),
});

export const CardinalResponseSchema = z.object({
  PolicyInquiryRs: z.object({
    MsgStatus: z.object({ StatusCd: str, StatusDesc: optStr }),
    PersAutoPolicy: z
      .object({
        PolicyNumber: str,
        LOBCd: str,
        PolicyStatusCd: str,
        ContractTerm: z.object({ EffectiveDt: str, ExpirationDt: str }),
        CurrentTermAmt: z.object({ Amt: str, CurCd: str }),
        InsuredOrPrincipal: z.object({
          GivenName: str,
          Surname: str,
          EmailAddr: optStr,
          PhoneNumber: optStr,
          Addr: z.object({
            Addr1: str,
            Addr2: optStr,
            City: str,
            StateProvCd: str,
            PostalCode: str,
            CountryCd: optStr,
          }),
        }),
        PersVeh: z
          .array(
            z.object({
              VehIdentificationNumber: str,
              ModelYear: str,
              Manufacturer: str,
              Model: str,
              Coverage: z.array(XmlCoverage).nullish(),
            }),
          )
          .nullish(),
        PersDriver: z
          .array(
            z.object({
              GivenName: str,
              Surname: str,
              BirthDt: optStr,
              LicensedStateProvCd: optStr,
              RelationshipCd: optStr,
            }),
          )
          .nullish(),
        Coverage: z.array(XmlCoverage).nullish(),
      })
      .nullish(),
  }),
});

function limit(limits: z.infer<typeof XmlCoverage>['Limit'], appliesTo: string[], path: string): number | null {
  const match = (limits ?? []).find((l) => appliesTo.includes(code(l.LimitAppliesToCd) ?? ''));
  return match ? optionalDollarsToCents(match.FormatInteger, path) : null;
}

function toCoverage(raw: z.infer<typeof XmlCoverage>, vehicleVin: string | null, path: string): Coverage {
  const carrierCode = requiredText(code(raw.CoverageCd), `${path}.CoverageCd`);
  return {
    type: COVERAGE[carrierCode] ?? 'OTHER',
    carrierCode,
    vehicleVin,
    limitPerPersonCents: limit(raw.Limit, ['PERPERSON'], `${path}.Limit`),
    limitPerOccurrenceCents: limit(raw.Limit, ['PERACC', 'CSL'], `${path}.Limit`),
    deductibleCents: optionalDollarsToCents(raw.Deductible?.Amt, `${path}.Deductible`),
  };
}

/** Pure: Cardinal XML document → NormalizedPolicy v1. */
export function parseCardinalPolicy(xml: string, retrievedAt: Date): NormalizedPolicy {
  // Refuse DTDs outright: no entity expansion, no external entities.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new CarrierError('INVALID_CARRIER_RESPONSE', 'Cardinal response contains a DTD, which is not accepted', 200);
  }
  if (XMLValidator.validate(xml) !== true) {
    throw new CarrierError('INVALID_CARRIER_RESPONSE', 'Cardinal returned malformed XML', 200);
  }

  return normalizeOrThrow(CARDINAL_CARRIER_ID, () => {
    const doc = CardinalResponseSchema.parse(parser.parse(xml)).PolicyInquiryRs;
    const statusCd = code(doc.MsgStatus.StatusCd);
    if (statusCd === 'NOT_FOUND') throw new CarrierError('POLICY_NOT_FOUND', 'Cardinal reported the policy was not found', 200);
    if (statusCd === 'DATA_UNAVAILABLE') {
      throw new CarrierError('CARRIER_DATA_UNAVAILABLE', 'Cardinal reported policy data is temporarily unavailable', 200);
    }
    if (statusCd !== 'SUCCESS' || !doc.PersAutoPolicy) {
      throw new CarrierError('INVALID_CARRIER_RESPONSE', `Cardinal returned status '${statusCd ?? 'missing'}' without a policy`, 200);
    }

    const p = doc.PersAutoPolicy;
    const ins = p.InsuredOrPrincipal;
    const vehicles = p.PersVeh ?? [];

    return finalizePolicy({
      schemaVersion: NORMALIZED_POLICY_SCHEMA_VERSION,
      carrierId: CARDINAL_CARRIER_ID,
      externalPolicyId: requiredText(p.PolicyNumber, 'PolicyNumber').toUpperCase(),
      policyholder: {
        firstName: requiredText(ins.GivenName, 'InsuredOrPrincipal.GivenName'),
        lastName: requiredText(ins.Surname, 'InsuredOrPrincipal.Surname'),
        email: email(ins.EmailAddr),
        phone: phone(ins.PhoneNumber),
        address: {
          line1: requiredText(ins.Addr.Addr1, 'Addr.Addr1'),
          line2: text(ins.Addr.Addr2),
          city: requiredText(ins.Addr.City, 'Addr.City'),
          state: stateCode(ins.Addr.StateProvCd, 'Addr.StateProvCd'),
          postalCode: postalCode(ins.Addr.PostalCode, 'Addr.PostalCode'),
          country: code(ins.Addr.CountryCd) ?? 'US',
        },
      },
      policyType: mapCode(p.LOBCd, LOB, 'LOBCd'),
      status: mapCode(p.PolicyStatusCd, STATUS, 'PolicyStatusCd'),
      effectiveDate: calendarDate(p.ContractTerm.EffectiveDt, 'ContractTerm.EffectiveDt'),
      expirationDate: calendarDate(p.ContractTerm.ExpirationDt, 'ContractTerm.ExpirationDt'),
      premium: {
        amountCents: dollarsToCents(p.CurrentTermAmt.Amt, 'CurrentTermAmt.Amt'),
        currency: currency(p.CurrentTermAmt.CurCd, 'CurrentTermAmt.CurCd'),
      },
      coverages: [
        ...(p.Coverage ?? []).map((c, i) => toCoverage(c, null, `Coverage.${i}`)),
        ...vehicles.flatMap((v, vi) => {
          const vehicleVin = vin(v.VehIdentificationNumber, `PersVeh.${vi}.VehIdentificationNumber`);
          return (v.Coverage ?? []).map((c, ci) => toCoverage(c, vehicleVin, `PersVeh.${vi}.Coverage.${ci}`));
        }),
      ],
      vehicles: vehicles.map((v, i) => ({
        vin: vin(v.VehIdentificationNumber, `PersVeh.${i}.VehIdentificationNumber`),
        year: year(v.ModelYear, `PersVeh.${i}.ModelYear`),
        make: requiredText(v.Manufacturer, `PersVeh.${i}.Manufacturer`),
        model: requiredText(v.Model, `PersVeh.${i}.Model`),
      })),
      drivers: (p.PersDriver ?? []).map((d, i) => ({
        firstName: requiredText(d.GivenName, `PersDriver.${i}.GivenName`),
        lastName: requiredText(d.Surname, `PersDriver.${i}.Surname`),
        dateOfBirth: optionalCalendarDate(d.BirthDt, `PersDriver.${i}.BirthDt`),
        licenseState: optionalStateCode(d.LicensedStateProvCd, `PersDriver.${i}.LicensedStateProvCd`),
        relationship: text(d.RelationshipCd) ? mapCode(d.RelationshipCd, RELATIONSHIP, `PersDriver.${i}.RelationshipCd`) : null,
      })),
      retrievedAt: retrievedAt.toISOString(),
    });
  });
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export function createCardinalAdapter(cfg: {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  maxResponseBytes: number;
}): CarrierAdapter {
  const auth = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
  return {
    carrierId: CARDINAL_CARRIER_ID,
    displayName: 'Cardinal Casualty',
    async fetchPolicy(externalPolicyId: string, ctx: FetchContext = {}) {
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<PolicyInquiryRq><RqUID>${escapeXml(ctx.correlationId ?? 'none')}</RqUID>` +
        `<PolicyNumber>${escapeXml(externalPolicyId)}</PolicyNumber></PolicyInquiryRq>`;
      const res = await carrierRequest({
        url: `${cfg.baseUrl}/PolicyInquiry`,
        method: 'POST',
        headers: { 'content-type': 'application/xml', accept: 'application/xml', authorization: auth },
        body,
        timeoutMs: cfg.timeoutMs,
        maxResponseBytes: cfg.maxResponseBytes,
        signal: ctx.signal,
      });
      const httpError = classifyHttpStatus(res);
      if (httpError) throw httpError;
      const policy = parseWithStatus(res.status, () => parseCardinalPolicy(res.body, new Date()));
      return { policy, httpStatus: res.status };
    },
  };
}
