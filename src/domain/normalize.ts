import { canonicalJson } from '../lib/canonical-json.js';
import { sha256Hex } from '../lib/crypto.js';
import {
  NormalizedPolicySchema,
  type Coverage,
  type Driver,
  type NormalizedPolicy,
  type Vehicle,
} from './normalized-policy.js';

/**
 * Normalization rules shared by every carrier adapter. Each rule exists so that a purely cosmetic
 * difference in an upstream payload (whitespace, letter case of codes, money/date/phone formatting,
 * array order) maps to the same NormalizedPolicy and therefore the same content hash.
 */
export class NormalizationError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'NormalizationError';
  }
}

/** Trim, Unicode NFC, collapse internal whitespace. Empty/whitespace-only → null. */
export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).normalize('NFC').replace(/\s+/g, ' ').trim();
  return s.length === 0 ? null : s;
}

export function requiredText(value: unknown, path: string): string {
  const s = text(value);
  if (s === null) throw new NormalizationError('required value is missing', path);
  return s;
}

/** Codes and enumerations compare case-insensitively: upper-case, inner whitespace → underscore. */
export function code(value: unknown): string | null {
  const s = text(value);
  return s === null ? null : s.toUpperCase().replace(/[\s-]+/g, '_');
}

export function requiredCode(value: unknown, path: string): string {
  const c = code(value);
  if (c === null) throw new NormalizationError('required code is missing', path);
  return c;
}

export function mapCode<T extends string>(value: unknown, table: Record<string, T>, path: string): T {
  const c = requiredCode(value, path);
  const mapped = table[c];
  if (mapped === undefined) throw new NormalizationError(`unrecognized value '${c}'`, path);
  return mapped;
}

export function vin(value: unknown, path: string): string {
  const s = requiredText(value, path)
    .toUpperCase()
    .replace(/[\s-]/g, '');
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(s)) throw new NormalizationError('invalid VIN format', path);
  return s;
}

export function email(value: unknown): string | null {
  const s = text(value);
  return s === null ? null : s.toLowerCase();
}

/** North American numbers → E.164 (+1XXXXXXXXXX). Already-E.164 numbers keep their country code. */
export function phone(value: unknown): string | null {
  const s = text(value);
  if (s === null) return null;
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!hasPlus && digits.length === 10) return `+1${digits}`;
  if (!hasPlus && digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (hasPlus && digits.length >= 7 && digits.length <= 15 && !digits.startsWith('0')) return `+${digits}`;
  return null; // unparseable numbers are dropped rather than failing the whole policy
}

export function stateCode(value: unknown, path: string): string {
  const s = requiredText(value, path).toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) throw new NormalizationError('invalid state code', path);
  return s;
}

export function optionalStateCode(value: unknown, path: string): string | null {
  return text(value) === null ? null : stateCode(value, path);
}

export function postalCode(value: unknown, path: string): string {
  const digits = requiredText(value, path).replace(/\D/g, '');
  if (digits.length === 5) return digits;
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  throw new NormalizationError('invalid US postal code', path);
}

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

function formatDate(y: number, m: number, d: number, path: string): string {
  if (!isValidCalendarDate(y, m, d)) throw new NormalizationError('invalid calendar date', path);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Policy dates are calendar dates in the carrier's local time, not instants. Accepted inputs:
 * `YYYY-MM-DD`, `YYYYMMDD`, `M/D/YYYY`, and ISO date-times whose *local* date part is taken verbatim
 * (`2026-04-01T00:01:00-05:00` → `2026-04-01`; converting to UTC first would shift the date).
 */
export function calendarDate(value: unknown, path: string): string {
  const s = requiredText(value, path);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) return formatDate(Number(m[1]), Number(m[2]), Number(m[3]), path);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return formatDate(Number(m[1]), Number(m[2]), Number(m[3]), path);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return formatDate(Number(m[3]), Number(m[1]), Number(m[2]), path);
  throw new NormalizationError(`unrecognized date format '${s}'`, path);
}

export function optionalCalendarDate(value: unknown, path: string): string | null {
  return text(value) === null ? null : calendarDate(value, path);
}

/**
 * Decimal money → integer cents without binary floating point: "$1,204.5" → 120450, 642.5 → 64250.
 * Sub-cent precision rounds half-up. Negative amounts are rejected (premiums/limits are never negative).
 */
export function dollarsToCents(value: unknown, path: string): number {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new NormalizationError('non-finite amount', path);
  const s = requiredText(value, path).replace(/[$,\s]/g, '').replace(/^USD/i, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new NormalizationError(`invalid amount '${s}'`, path);
  const whole = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(3, '0');
  let result = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) result += 1;
  if (!Number.isSafeInteger(result)) throw new NormalizationError('amount out of range', path);
  return result;
}

export function optionalDollarsToCents(value: unknown, path: string): number | null {
  return text(value) === null ? null : dollarsToCents(value, path);
}

export function integerCents(value: unknown, path: string): number {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new NormalizationError('expected a non-negative integer amount in cents', path);
  }
  return n;
}

export function optionalIntegerCents(value: unknown, path: string): number | null {
  return value === null || value === undefined || value === '' ? null : integerCents(value, path);
}

export function year(value: unknown, path: string): number {
  const n = Number(requiredText(value, path));
  if (!Number.isInteger(n) || n < 1900 || n > 2100) throw new NormalizationError('invalid model year', path);
  return n;
}

export function currency(value: unknown, path: string): string {
  const c = requiredCode(value, path);
  if (!/^[A-Z]{3}$/.test(c)) throw new NormalizationError('invalid ISO-4217 currency', path);
  return c;
}

/** Splits "FIRST [MIDDLE] LAST" on the last space. Used for carriers that only send a full name. */
export function splitFullName(value: unknown, path: string): { firstName: string; lastName: string } {
  const s = requiredText(value, path);
  const idx = s.lastIndexOf(' ');
  if (idx <= 0) throw new NormalizationError('full name must contain first and last name', path);
  return { firstName: s.slice(0, idx), lastName: s.slice(idx + 1) };
}

// Ordinal (code-unit) comparison — locale-independent, so ordering is identical on every host.
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareCoverages(a: Coverage, b: Coverage): number {
  return cmp(a.vehicleVin ?? '', b.vehicleVin ?? '') || cmp(a.type, b.type) || cmp(a.carrierCode, b.carrierCode);
}

const compareVehicles = (a: Vehicle, b: Vehicle) => cmp(a.vin, b.vin);
const compareDrivers = (a: Driver, b: Driver) =>
  cmp(a.lastName, b.lastName) || cmp(a.firstName, b.firstName) || cmp(a.dateOfBirth ?? '', b.dateOfBirth ?? '');

/**
 * Final step of every adapter: put arrays in canonical order and validate the result against the
 * v1 schema. Any violation surfaces as a NormalizationError (→ INVALID_CARRIER_RESPONSE).
 */
export function finalizePolicy(candidate: NormalizedPolicy): NormalizedPolicy {
  const ordered: NormalizedPolicy = {
    ...candidate,
    coverages: [...candidate.coverages].sort(compareCoverages),
    vehicles: [...candidate.vehicles].sort(compareVehicles),
    drivers: [...candidate.drivers].sort(compareDrivers),
  };
  const result = NormalizedPolicySchema.safeParse(ordered);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new NormalizationError(issue?.message ?? 'schema violation', issue?.path.join('.'));
  }
  return result.data;
}

/**
 * Content hash of a normalized policy, excluding `retrievedAt` (which changes on every fetch).
 * Two retrievals with the same hash are, by construction, semantically identical.
 */
export function snapshotHash(policy: NormalizedPolicy): string {
  const { retrievedAt: _ignored, ...content } = policy;
  return sha256Hex(canonicalJson(content));
}
