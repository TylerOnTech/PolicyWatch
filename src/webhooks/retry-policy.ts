import type { SendResult } from './http-sender.js';

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": the delay for attempt n (1-based, the attempt that just
 * failed) is uniformly distributed in [d/2, d] where d = min(maxMs, baseMs · 2^(n−1)). Half the delay
 * is guaranteed (no immediate hammering); the random half de-synchronizes retries across deliveries.
 */
export function backoffDelayMs(failedAttempt: number, opts: BackoffOptions): number {
  const random = opts.random ?? Math.random;
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, failedAttempt - 1));
  const half = exp / 2;
  return Math.round(half + random() * half);
}

export type AttemptClassification =
  | { outcome: 'SUCCESS' }
  | { outcome: 'HTTP_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR' | 'BLOCKED_DESTINATION'; retryable: boolean; retryAfterSeconds?: number; message: string };

/**
 * Which failures are worth retrying. Retryable: timeouts, connection errors, 408, 425, 429 and 5xx.
 * Everything else (other 4xx, 3xx since redirects are not followed, SSRF blocks) is a permanent
 * failure for this delivery; an operator can still redeliver manually after fixing the receiver.
 */
export function classifyAttempt(result: SendResult): AttemptClassification {
  if (result.kind === 'error') {
    return {
      outcome: result.error,
      retryable: result.error !== 'BLOCKED_DESTINATION',
      message: result.message,
    };
  }
  const s = result.status;
  if (s >= 200 && s < 300) return { outcome: 'SUCCESS' };
  const retryable = s === 408 || s === 425 || s === 429 || s >= 500;
  return {
    outcome: 'HTTP_ERROR',
    retryable,
    retryAfterSeconds: result.retryAfterSeconds,
    message: `Receiver responded with HTTP ${s}`,
  };
}
