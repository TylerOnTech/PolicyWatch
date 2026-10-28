import { z } from 'zod';
import { NormalizationError } from '../../domain/normalize.js';
import { CarrierError } from '../types.js';

/** Values carriers send inconsistently as strings or numbers. */
export const looseScalar = z.union([z.string(), z.number()]);
export const optionalLoose = looseScalar.nullish();

/**
 * Runs a pure parse/normalize function and converts structural problems into a classified
 * INVALID_CARRIER_RESPONSE. Error messages carry field paths only — never values, which may be PII.
 */
export function normalizeOrThrow<T>(carrierId: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CarrierError) throw err;
    if (err instanceof z.ZodError) {
      const paths = err.issues.slice(0, 5).map((i) => i.path.join('.') || '(root)');
      throw new CarrierError('INVALID_CARRIER_RESPONSE', `${carrierId} response failed validation at: ${paths.join(', ')}`);
    }
    if (err instanceof NormalizationError) {
      throw new CarrierError('INVALID_CARRIER_RESPONSE', `${carrierId} response could not be normalized: ${err.path ?? 'unknown field'}`);
    }
    throw err;
  }
}

/** Attach the HTTP status of the response being parsed to any classification error it raises. */
export function parseWithStatus<T>(httpStatus: number, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CarrierError && err.httpStatus === undefined) {
      throw new CarrierError(err.category, err.message, httpStatus, err.retryAfterSeconds);
    }
    throw err;
  }
}
