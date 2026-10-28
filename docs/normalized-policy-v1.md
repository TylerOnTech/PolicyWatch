# NormalizedPolicy v1 contract

Every carrier adapter converts its carrier's response into this single shape. Snapshots, change
detection and the API all operate on it; nothing downstream knows a carrier's wire format.

Source of truth: `src/domain/normalized-policy.ts` (Zod schema, strict — unknown keys are rejected).
Every adapter output is validated against it before it can be stored.

## Fields

| Field | Type | Rules |
|---|---|---|
| `schemaVersion` | `"1.0"` | Bumped on any breaking change. |
| `carrierId` | string | Adapter ID: `acme`, `bluebird`, `cardinal`. |
| `externalPolicyId` | string | Carrier policy number, upper-cased. Must equal the enrolled number or the response is rejected. |
| `policyholder.firstName`, `.lastName` | string | Whitespace-normalized; case preserved. Single-field full names are split on the last space. |
| `policyholder.email` | string \| null | Lower-cased. |
| `policyholder.phone` | string \| null | E.164 (`+15550102234`). Unparseable numbers become `null` rather than failing the policy. |
| `policyholder.address` | object | `line1`, `line2` (empty → `null`), `city`, `state` (2 letters, upper), `postalCode` (`12345` or `12345-6789`, leading zeros kept), `country` (ISO-3166 alpha-2). |
| `policyType` | `AUTO` \| `HOME` \| `RENTERS` \| `UMBRELLA` | Simulated carriers produce `AUTO`. |
| `status` | `ACTIVE` \| `PENDING` \| `CANCELLED` \| `EXPIRED` | Mapped from carrier codes through an explicit table. **Unknown codes are rejected, never guessed.** |
| `effectiveDate`, `expirationDate` | `YYYY-MM-DD` | Calendar dates (see below). `expirationDate > effectiveDate`. |
| `premium.amountCents` | integer ≥ 0 | Integer minor units — never floating point. |
| `premium.currency` | ISO-4217 | Upper-cased. |
| `coverages[]` | array | See below. Sorted canonically. |
| `vehicles[]` | array | `vin` (17 chars, no I/O/Q, upper), `year`, `make`, `model`. Unique by VIN. Sorted by VIN. |
| `drivers[]` | array | `firstName`, `lastName`, `dateOfBirth` (date \| null), `licenseState` (\| null), `relationship` (`NAMED_INSURED`, `SPOUSE`, `CHILD`, `OTHER` \| null). Sorted by last, first name, DOB. |
| `retrievedAt` | ISO-8601 UTC | When PolicyWatch received the response. **Excluded from the content hash.** |

### Coverage

| Field | Type | Notes |
|---|---|---|
| `type` | enum | `BODILY_INJURY_LIABILITY`, `PROPERTY_DAMAGE_LIABILITY`, `UNINSURED_MOTORIST_BI`, `UNDERINSURED_MOTORIST_BI`, `MEDICAL_PAYMENTS`, `PERSONAL_INJURY_PROTECTION`, `COLLISION`, `COMPREHENSIVE`, `RENTAL_REIMBURSEMENT`, `ROADSIDE_ASSISTANCE`, `OTHER` |
| `carrierCode` | string | Carrier's own code (upper-cased). Unknown codes map to `type: OTHER` and stay distinguishable by this field. |
| `vehicleVin` | string \| null | `null` = policy-level (liability); otherwise must reference a listed vehicle. |
| `limitPerPersonCents` | integer \| null | |
| `limitPerOccurrenceCents` | integer \| null | Per accident, or a combined single limit. |
| `deductibleCents` | integer \| null | |

Coverage identity (for change detection) is `(vehicleVin ?? POLICY, type, carrierCode)`.

## Example

```json
{
  "schemaVersion": "1.0",
  "carrierId": "acme",
  "externalPolicyId": "ACM-AUTO-100234",
  "policyholder": {
    "firstName": "Jordan",
    "lastName": "Rivera",
    "email": "jordan.rivera@example.com",
    "phone": "+15550102234",
    "address": { "line1": "1420 Maple Grove Ave", "line2": "Apt 3B", "city": "Columbus", "state": "OH", "postalCode": "43215", "country": "US" }
  },
  "policyType": "AUTO",
  "status": "ACTIVE",
  "effectiveDate": "2026-05-01",
  "expirationDate": "2026-11-01",
  "premium": { "amountCents": 64250, "currency": "USD" },
  "coverages": [
    { "type": "BODILY_INJURY_LIABILITY", "carrierCode": "BI", "vehicleVin": null, "limitPerPersonCents": 10000000, "limitPerOccurrenceCents": 30000000, "deductibleCents": null },
    { "type": "MEDICAL_PAYMENTS", "carrierCode": "MEDPAY", "vehicleVin": null, "limitPerPersonCents": 500000, "limitPerOccurrenceCents": null, "deductibleCents": null },
    { "type": "PROPERTY_DAMAGE_LIABILITY", "carrierCode": "PD", "vehicleVin": null, "limitPerPersonCents": null, "limitPerOccurrenceCents": 10000000, "deductibleCents": null },
    { "type": "UNINSURED_MOTORIST_BI", "carrierCode": "UMBI", "vehicleVin": null, "limitPerPersonCents": 10000000, "limitPerOccurrenceCents": 30000000, "deductibleCents": null },
    { "type": "COLLISION", "carrierCode": "COLL", "vehicleVin": "1HGCV1F30MA000101", "limitPerPersonCents": null, "limitPerOccurrenceCents": null, "deductibleCents": 50000 },
    { "type": "COMPREHENSIVE", "carrierCode": "COMP", "vehicleVin": "1HGCV1F30MA000101", "limitPerPersonCents": null, "limitPerOccurrenceCents": null, "deductibleCents": 25000 }
  ],
  "vehicles": [{ "vin": "1HGCV1F30MA000101", "year": 2021, "make": "Honda", "model": "Accord" }],
  "drivers": [{ "firstName": "Jordan", "lastName": "Rivera", "dateOfBirth": "1990-05-17", "licenseState": "OH", "relationship": "NAMED_INSURED" }],
  "retrievedAt": "2026-10-28T12:00:00.000Z"
}
```

All data in this repository is synthetic: invented names, `example.*` e-mail domains, the fictional
555-01xx phone range and fabricated VINs.

## Normalization rules (why cosmetic differences never create events)

Implemented in `src/domain/normalize.ts`, shared by all adapters, and covered by tests that render
each seeded policy in two deliberately different formats and assert an identical content hash.

| Difference in upstream payload | Rule |
|---|---|
| Leading/trailing/repeated whitespace, Unicode composition | Trim, collapse to one space, NFC. Empty strings → `null`. |
| Code casing / separators (`in_force`, ` IN FORCE `, `coll`) | Upper-case, spaces/hyphens → `_`, then explicit lookup table. |
| Money formats (`"642.50"`, `642.5`, `"$1,204.00"`, cents integers) | Decimal-string parsing to integer cents (no binary floating point), half-up at the third decimal. |
| Date formats (`2026-04-01`, `04/01/2026`, `4/1/2026`, `20260401`) | → `YYYY-MM-DD`; impossible dates rejected. |
| Date-times with offsets (`2026-04-01T00:01:00-05:00`) | The carrier's **local calendar date** is kept. Converting to UTC first would move late-evening dates to the next day. |
| Phone formats (`(555) 010-2234`, `555.010.2234`, `+1 555 010 2234`) | E.164. |
| Postal codes (`787040001`, `78704-0001`, XML `02134`) | `12345` / `12345-6789`; XML values are never coerced to numbers, so leading zeros survive. |
| VIN case / separators | Upper-case, strip spaces and hyphens, validate the character set. |
| E-mail case | Lower-case. |
| Array order (vehicles, drivers, coverages) | Sorted by a code-unit comparator (locale-independent, identical on every host). |
| Response metadata (`generatedAt`, request IDs) | Not part of the contract, so not part of the hash. |

The content hash is `SHA-256(canonical JSON of the policy without retrievedAt)` where canonical JSON
sorts object keys. It decides **whether** to store a new version; it never decides **what** changed —
that is the differ's job, field by field.

## Carrier mapping summary

| Concept | Acme Mutual (JSON) | Bluebird (JSON) | Cardinal (XML) |
|---|---|---|---|
| Transport / auth | `GET /v2/policies/{n}`, `x-api-key` | `GET /api/v1/policy?policy_id=`, Bearer | `POST /PolicyInquiry` XML, Basic |
| Status | `IN_FORCE`/`PENDING_ISSUE`/`CANCELLED`/`EXPIRED` | `active`/`pending`/`cancelled`/`expired` | `A`/`P`/`C`/`E` |
| Dates | ISO dates | ISO date-time with offset | `MM/DD/YYYY` |
| Premium | decimal dollars (string or number) | integer cents | `$1,204.00` |
| Name | given + family | single `full_name` (upper-case) | `GivenName` + `Surname` |
| "No data right now" | HTTP 503 + `Retry-After` | HTTP 200 `{status:"processing"}` | HTTP 200 `<StatusCd>DATA_UNAVAILABLE` |
| Not found | HTTP 404 | HTTP 404 | HTTP 200 `<StatusCd>NOT_FOUND` |

Adding a carrier means one adapter module (transport + pure `parse…Policy(body, retrievedAt)`) and
one line in `src/carriers/registry.ts`. The pure parse function is unit-testable without HTTP.
