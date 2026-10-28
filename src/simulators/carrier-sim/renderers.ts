import type { SimCoverage, SimCoverageType, SimPolicy } from './store.js';

/**
 * Renders one internal policy into each carrier's wire format. The code tables here are written
 * independently of the adapters (not imported from them) so that adapter tests exercise a genuine
 * translation rather than a mapping compared against itself.
 *
 * `variant` > 0 with an odd value produces a cosmetically different but semantically identical
 * response (case, whitespace, number/money/date/phone formatting, array order). The adapters must
 * normalize both variants to the same content hash.
 */

const noisy = (variant: number) => variant % 2 === 1;
const dollars = (cents: number) => (cents / 100).toFixed(2);
const reorder = <T>(items: T[], variant: number) => (noisy(variant) ? [...items].reverse() : items);
const fmtPhone = (digits: string, style: 'paren' | 'dash' | 'dot' | 'intl') => {
  const a = digits.slice(0, 3);
  const b = digits.slice(3, 6);
  const c = digits.slice(6);
  return style === 'paren' ? `(${a}) ${b}-${c}` : style === 'dash' ? `${a}-${b}-${c}` : style === 'dot' ? `${a}.${b}.${c}` : `+1 ${a} ${b} ${c}`;
};
const mixedCaseEmail = (email: string) => email.replace(/^(.)/, (c) => c.toUpperCase()).replace(/@(.)/, (_m, c: string) => `@${c.toUpperCase()}`);
const zip9 = (zip: string) => (zip.length === 9 ? `${zip.slice(0, 5)}-${zip.slice(5)}` : zip);

// ---------------------------------------------------------------- Acme Mutual (camelCase JSON)

const ACME_STATUS = { ACTIVE: 'IN_FORCE', PENDING: 'PENDING_ISSUE', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED' } as const;
const ACME_CODE: Record<SimCoverageType, string> = {
  BODILY_INJURY_LIABILITY: 'BI',
  PROPERTY_DAMAGE_LIABILITY: 'PD',
  UNINSURED_MOTORIST_BI: 'UMBI',
  MEDICAL_PAYMENTS: 'MEDPAY',
  COLLISION: 'COLL',
  COMPREHENSIVE: 'COMP',
  RENTAL_REIMBURSEMENT: 'RREIM',
  ROADSIDE_ASSISTANCE: 'TOW',
};
const ACME_REL = { NAMED_INSURED: 'SELF', SPOUSE: 'SPOUSE', CHILD: 'CHILD', OTHER: 'OTHER' } as const;

function acmeCoverage(c: SimCoverage, variant: number) {
  const money = (cents?: number) => (cents === undefined ? undefined : noisy(variant) ? cents / 100 : dollars(cents));
  const limits =
    c.perPersonCents !== undefined || c.perOccurrenceCents !== undefined
      ? { perPerson: money(c.perPersonCents) ?? null, perAccident: money(c.perOccurrenceCents) ?? null }
      : null;
  return {
    coverageCode: noisy(variant) ? ACME_CODE[c.type].toLowerCase() : ACME_CODE[c.type],
    limits,
    deductible: money(c.deductibleCents) ?? null,
  };
}

export function renderAcme(p: SimPolicy, variant: number) {
  const n = noisy(variant);
  return {
    policy: {
      policyNumber: p.policyNumber,
      lineOfBusiness: 'PERSONAL_AUTO',
      policyStatus: n ? ` ${ACME_STATUS[p.status].toLowerCase()} ` : ACME_STATUS[p.status],
      term: { effectiveDate: p.effectiveDate, expirationDate: p.expirationDate },
      totalPremium: n ? { amount: `$${Number(dollars(p.premiumCents)).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, currencyCode: 'usd' } : { amount: dollars(p.premiumCents), currencyCode: 'USD' },
      namedInsured: {
        givenName: p.insured.firstName,
        familyName: n ? ` ${p.insured.lastName}` : p.insured.lastName,
        emailAddress: n ? mixedCaseEmail(p.insured.email) : p.insured.email,
        phoneNumber: fmtPhone(p.insured.phone, n ? 'intl' : 'paren'),
        mailingAddress: {
          street1: n ? p.insured.line1.replace(/ /, '  ') : p.insured.line1,
          street2: p.insured.line2 ?? (n ? '' : null),
          city: p.insured.city,
          stateCode: n ? p.insured.state.toLowerCase() : p.insured.state,
          zip: zip9(p.insured.postalCode),
        },
      },
      vehicles: reorder(p.vehicles, variant).map((v) => ({
        vin: n ? v.vin.toLowerCase() : v.vin,
        modelYear: n ? String(v.year) : v.year,
        make: v.make,
        model: v.model,
        coverages: reorder(v.coverages, variant).map((c) => acmeCoverage(c, variant)),
      })),
      drivers: reorder(p.drivers, variant).map((d) => ({
        givenName: d.firstName,
        familyName: d.lastName,
        birthDate: d.dateOfBirth,
        licenseState: d.licenseState,
        relationToInsured: ACME_REL[d.relationship],
      })),
      policyCoverages: reorder(p.policyCoverages, variant).map((c) => acmeCoverage(c, variant)),
    },
    responseMetadata: { generatedAt: new Date().toISOString(), apiVersion: '2.4' },
  };
}

// ---------------------------------------------------------------- Bluebird (snake_case JSON)

const BB_CODE: Record<SimCoverageType, string> = {
  BODILY_INJURY_LIABILITY: 'bodily_injury',
  PROPERTY_DAMAGE_LIABILITY: 'property_damage',
  UNINSURED_MOTORIST_BI: 'uninsured_motorist',
  MEDICAL_PAYMENTS: 'medical_payments',
  COLLISION: 'collision',
  COMPREHENSIVE: 'comprehensive',
  RENTAL_REIMBURSEMENT: 'rental',
  ROADSIDE_ASSISTANCE: 'roadside',
};
const BB_REL = { NAMED_INSURED: 'primary', SPOUSE: 'spouse', CHILD: 'dependent', OTHER: 'other' } as const;

/** Bluebird terms start at 12:01 a.m. local (Central) time; the offset must not shift the date. */
const bbTimestamp = (date: string, variant: number) => (noisy(variant) ? `${date}T00:01:00-0500` : `${date}T00:01:00-05:00`);

export function renderBluebird(p: SimPolicy, variant: number) {
  const n = noisy(variant);
  const lines = [
    ...p.policyCoverages.map((c) => ({ c, vin: null as string | null })),
    ...p.vehicles.flatMap((v) => v.coverages.map((c) => ({ c, vin: v.vin }))),
  ];
  return {
    status: 'ok',
    data: {
      policy_id: p.policyNumber,
      product_code: n ? 'AUTO' : 'auto',
      policy_state: n ? p.status : p.status.toLowerCase(),
      term_start: bbTimestamp(p.effectiveDate, variant),
      term_end: bbTimestamp(p.expirationDate, variant),
      premium_cents: n ? String(p.premiumCents) : p.premiumCents,
      currency: 'USD',
      insured: {
        full_name: `${p.insured.firstName}${n ? '  ' : ' '}${p.insured.lastName}`.toUpperCase(),
        email: n ? p.insured.email.toUpperCase() : p.insured.email,
        phone_e164: n ? `+1 ${fmtPhone(p.insured.phone, 'paren')}` : `+1${p.insured.phone}`,
        addr_line1: p.insured.line1,
        addr_line2: p.insured.line2 ?? '',
        addr_city: p.insured.city,
        addr_state: p.insured.state,
        addr_zip: n ? p.insured.postalCode : zip9(p.insured.postalCode),
      },
      units: reorder(p.vehicles, variant).map((v) => ({
        unit_type: n ? 'VEHICLE' : 'vehicle',
        vin: v.vin,
        model_year: String(v.year),
        make: v.make.toUpperCase(),
        model: v.model.toUpperCase(),
      })),
      operators: reorder(p.drivers, variant).map((d) => ({
        name: `${d.firstName} ${d.lastName}`,
        dob: d.dateOfBirth,
        license_state: n ? d.licenseState.toLowerCase() : d.licenseState,
        relationship: BB_REL[d.relationship],
      })),
      coverage_lines: reorder(lines, variant).map(({ c, vin }) => ({
        type: n ? BB_CODE[c.type].toUpperCase() : BB_CODE[c.type],
        unit_vin: vin,
        per_person_limit_cents: c.perPersonCents ?? null,
        per_accident_limit_cents: c.perOccurrenceCents ?? null,
        deductible_cents: c.deductibleCents ?? null,
      })),
    },
  };
}

// ---------------------------------------------------------------- Cardinal (ACORD-style XML)

const CC_STATUS = { ACTIVE: 'A', PENDING: 'P', CANCELLED: 'C', EXPIRED: 'E' } as const;
const CC_CODE: Record<SimCoverageType, string> = {
  BODILY_INJURY_LIABILITY: 'BI',
  PROPERTY_DAMAGE_LIABILITY: 'PD',
  UNINSURED_MOTORIST_BI: 'UM',
  MEDICAL_PAYMENTS: 'MEDPM',
  COLLISION: 'COLL',
  COMPREHENSIVE: 'COMP',
  RENTAL_REIMBURSEMENT: 'RREIM',
  ROADSIDE_ASSISTANCE: 'TL',
};
const CC_REL = { NAMED_INSURED: 'IN', SPOUSE: 'SP', CHILD: 'CH', OTHER: 'OT' } as const;

export const xmlEscape = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const el = (tag: string, value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? `<${tag}/>` : `<${tag}>${xmlEscape(String(value))}</${tag}>`;

const ccDate = (iso: string, variant: number) => {
  const [y, m, d] = iso.split('-');
  return noisy(variant) ? `${Number(m)}/${Number(d)}/${y}` : `${m}/${d}/${y}`;
};
const ccMoney = (cents: number, variant: number) =>
  noisy(variant) ? dollars(cents) : `$${Number(dollars(cents)).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

function ccCoverage(c: SimCoverage, variant: number): string {
  const limits = [
    c.perPersonCents !== undefined ? `<Limit>${el('FormatInteger', c.perPersonCents / 100)}${el('LimitAppliesToCd', 'PerPerson')}</Limit>` : '',
    c.perOccurrenceCents !== undefined ? `<Limit>${el('FormatInteger', c.perOccurrenceCents / 100)}${el('LimitAppliesToCd', 'PerAcc')}</Limit>` : '',
  ].join('');
  const deductible = c.deductibleCents !== undefined ? `<Deductible>${el('Amt', ccMoney(c.deductibleCents, variant))}</Deductible>` : '';
  return `<Coverage>${el('CoverageCd', CC_CODE[c.type])}${limits}${deductible}</Coverage>`;
}

export function renderCardinalStatus(statusCd: string, desc: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><PolicyInquiryRs><MsgStatus>${el('StatusCd', statusCd)}${el('StatusDesc', desc)}</MsgStatus></PolicyInquiryRs>`;
}

export function renderCardinal(p: SimPolicy, variant: number): string {
  const n = noisy(variant);
  const pad = (s: string) => (n ? `\n    ${s}` : s);
  const i = p.insured;
  const vehicles = reorder(p.vehicles, variant)
    .map(
      (v) =>
        `<PersVeh>${el('VehIdentificationNumber', v.vin)}${el('ModelYear', v.year)}${el('Manufacturer', v.make)}${el('Model', v.model)}` +
        reorder(v.coverages, variant).map((c) => ccCoverage(c, variant)).join('') +
        `</PersVeh>`,
    )
    .map(pad)
    .join('');
  const drivers = reorder(p.drivers, variant)
    .map(
      (d) =>
        `<PersDriver>${el('GivenName', d.firstName)}${el('Surname', d.lastName)}${el('BirthDt', d.dateOfBirth)}` +
        `${el('LicensedStateProvCd', d.licenseState)}${el('RelationshipCd', CC_REL[d.relationship])}</PersDriver>`,
    )
    .map(pad)
    .join('');
  const coverages = reorder(p.policyCoverages, variant).map((c) => pad(ccCoverage(c, variant))).join('');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<PolicyInquiryRs><MsgStatus>${el('StatusCd', 'SUCCESS')}</MsgStatus><PersAutoPolicy>` +
    pad(el('PolicyNumber', p.policyNumber)) +
    el('LOBCd', 'AUTOP') +
    el('PolicyStatusCd', n ? CC_STATUS[p.status].toLowerCase() : CC_STATUS[p.status]) +
    `<ContractTerm>${el('EffectiveDt', ccDate(p.effectiveDate, variant))}${el('ExpirationDt', ccDate(p.expirationDate, variant))}</ContractTerm>` +
    `<CurrentTermAmt>${el('Amt', ccMoney(p.premiumCents, variant))}${el('CurCd', 'USD')}</CurrentTermAmt>` +
    `<InsuredOrPrincipal>${el('GivenName', n ? ` ${i.firstName} ` : i.firstName)}${el('Surname', i.lastName)}` +
    `${el('EmailAddr', n ? mixedCaseEmail(i.email) : i.email)}${el('PhoneNumber', fmtPhone(i.phone, n ? 'paren' : 'dot'))}` +
    `<Addr>${el('Addr1', i.line1)}${el('Addr2', i.line2)}${el('City', i.city)}${el('StateProvCd', i.state)}` +
    `${el('PostalCode', zip9(i.postalCode))}${el('CountryCd', 'US')}</Addr></InsuredOrPrincipal>` +
    vehicles +
    drivers +
    coverages +
    `</PersAutoPolicy></PolicyInquiryRs>`
  );
}
