import { z } from 'zod';
import { badRequest, notFound } from '../lib/errors.js';
import { isValidId, type IdPrefix } from '../lib/ids.js';

export const LimitParam = z.coerce.number().int().min(1).max(100).default(20);
export const CursorParam = z.string().min(1).max(200).optional();

export const BooleanParam = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** Opaque keyset cursor: base64url(JSON{ k }) where k is the last row's sort key. */
export function encodeCursor(key: string | number): string {
  return Buffer.from(JSON.stringify({ k: key }), 'utf8').toString('base64url');
}

export function decodeCursor<T extends 'string' | 'number'>(cursor: string | undefined, kind: T): (T extends 'string' ? string : number) | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { k?: unknown };
    if (typeof parsed.k === kind) return parsed.k as T extends 'string' ? string : number;
  } catch {
    // fall through
  }
  throw badRequest('INVALID_CURSOR', 'The pagination cursor is invalid or expired');
}

export interface Page<T> {
  data: T[];
  pagination: { limit: number; nextCursor: string | null };
}

/** Callers fetch `limit + 1` rows; the extra row only signals that another page exists. */
export function toPage<R, T>(rows: R[], limit: number, key: (row: R) => string | number, map: (row: R) => T): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    data: pageRows.map(map),
    pagination: { limit, nextCursor: hasMore ? encodeCursor(key(pageRows[pageRows.length - 1]!)) : null },
  };
}

/** Malformed IDs are reported as "not found" rather than leaking ID-format details. */
export function requireId(value: string | string[] | undefined, prefix: IdPrefix, resource: string): string {
  if (typeof value !== 'string' || !isValidId(value, prefix)) throw notFound(resource, String(value ?? ''));
  return value;
}
