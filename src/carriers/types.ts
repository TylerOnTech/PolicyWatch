import type { NormalizedPolicy } from '../domain/normalized-policy.js';

export const FAILURE_CATEGORIES = [
  'CARRIER_TIMEOUT',
  'CARRIER_UNAVAILABLE',
  'CARRIER_RATE_LIMITED',
  'CARRIER_AUTH_FAILED',
  'CARRIER_REQUEST_REJECTED',
  'CARRIER_DATA_UNAVAILABLE',
  'POLICY_NOT_FOUND',
  'INVALID_CARRIER_RESPONSE',
  'INTERNAL_ERROR',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Transient categories are expected to clear on their own; the others usually need a human. */
export const TRANSIENT_FAILURES: ReadonlySet<FailureCategory> = new Set([
  'CARRIER_TIMEOUT',
  'CARRIER_UNAVAILABLE',
  'CARRIER_RATE_LIMITED',
  'CARRIER_DATA_UNAVAILABLE',
]);

/**
 * Any reason a carrier's answer cannot be trusted as the current state of the policy. Raising one of
 * these never changes stored policy state: an outage is *not* a cancellation.
 */
export class CarrierError extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'CarrierError';
  }

  get transient(): boolean {
    return TRANSIENT_FAILURES.has(this.category);
  }
}

export interface FetchContext {
  correlationId?: string;
  signal?: AbortSignal;
}

export interface CarrierFetchResult {
  policy: NormalizedPolicy;
  httpStatus: number;
}

export interface CarrierAdapter {
  readonly carrierId: string;
  readonly displayName: string;
  /** Retrieve and normalize one policy. Throws CarrierError for every non-success outcome. */
  fetchPolicy(externalPolicyId: string, ctx?: FetchContext): Promise<CarrierFetchResult>;
}
