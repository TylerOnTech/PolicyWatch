/** Pure timing helpers for the monitoring schedule. */

const jitter = (maxMs: number, random: () => number) => Math.floor(random() * Math.max(0, maxMs));

/** Next routine check: interval plus up to 10% (max 30 s) jitter so enrollments don't stay in lockstep. */
export function nextRoutineCheck(now: Date, intervalSeconds: number, random: () => number = Math.random): Date {
  const intervalMs = intervalSeconds * 1000;
  return new Date(now.getTime() + intervalMs + jitter(Math.min(intervalMs / 10, 30_000), random));
}

/**
 * After a failed check: exponential backoff from `baseSeconds`, never longer than the policy's normal
 * interval, honoring a carrier Retry-After hint when it is longer.
 */
export function nextCheckAfterFailure(
  now: Date,
  opts: { intervalSeconds: number; consecutiveFailures: number; baseSeconds: number; retryAfterSeconds?: number },
  random: () => number = Math.random,
): Date {
  const exp = opts.baseSeconds * 2 ** Math.max(0, opts.consecutiveFailures - 1);
  const seconds = Math.max(Math.min(exp, opts.intervalSeconds), opts.retryAfterSeconds ?? 0);
  const ms = seconds * 1000;
  return new Date(now.getTime() + ms + jitter(ms / 10, random));
}
