import { describe, expect, it } from 'vitest';
import { nextCheckAfterFailure, nextRoutineCheck } from '../../src/monitoring/scheduling.js';
import { backoffDelayMs, classifyAttempt } from '../../src/webhooks/retry-policy.js';

describe('webhook backoff', () => {
  const opts = { baseMs: 1_000, maxMs: 60_000 };

  it('doubles per attempt and keeps jitter within [d/2, d]', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const d = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
      expect(backoffDelayMs(attempt, { ...opts, random: () => 0 })).toBe(d / 2);
      expect(backoffDelayMs(attempt, { ...opts, random: () => 0.999999 })).toBeLessThanOrEqual(d);
    }
  });

  it('is capped by maxMs', () => {
    expect(backoffDelayMs(30, { ...opts, random: () => 1 })).toBe(60_000);
  });

  it('spreads concurrent retries (jitter)', () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffDelayMs(4, opts)));
    expect(delays.size).toBeGreaterThan(10);
  });
});

describe('attempt classification', () => {
  const response = (status: number, retryAfterSeconds?: number) =>
    classifyAttempt({ kind: 'response', status, bodySnippet: '', durationMs: 5, retryAfterSeconds });

  it.each([200, 201, 202, 204])('%d is success', (s) => expect(response(s).outcome).toBe('SUCCESS'));

  it.each([408, 425, 429, 500, 502, 503, 504])('%d is retryable', (s) => {
    expect(response(s)).toMatchObject({ outcome: 'HTTP_ERROR', retryable: true });
  });

  it.each([301, 302, 400, 401, 403, 404, 410, 422])('%d is permanent', (s) => {
    expect(response(s)).toMatchObject({ outcome: 'HTTP_ERROR', retryable: false });
  });

  it('passes Retry-After through', () => {
    expect(response(429, 120)).toMatchObject({ retryAfterSeconds: 120 });
  });

  it('timeouts and network errors are retryable; blocked destinations are not', () => {
    expect(classifyAttempt({ kind: 'error', error: 'TIMEOUT', message: 't', durationMs: 1 })).toMatchObject({ retryable: true });
    expect(classifyAttempt({ kind: 'error', error: 'NETWORK_ERROR', message: 'n', durationMs: 1 })).toMatchObject({ retryable: true });
    expect(classifyAttempt({ kind: 'error', error: 'BLOCKED_DESTINATION', message: 'b', durationMs: 1 })).toMatchObject({
      retryable: false,
    });
  });
});

describe('policy check scheduling', () => {
  const now = new Date('2026-10-28T00:00:00.000Z');

  it('routine checks add up to 10% jitter (max 30 s) to the interval', () => {
    expect(nextRoutineCheck(now, 3600, () => 0).getTime() - now.getTime()).toBe(3_600_000);
    expect(nextRoutineCheck(now, 3600, () => 0.999).getTime() - now.getTime()).toBeLessThan(3_630_000);
    expect(nextRoutineCheck(now, 60, () => 0.999).getTime() - now.getTime()).toBeLessThan(66_000);
  });

  it('failure backoff grows exponentially but never exceeds the normal interval', () => {
    const delay = (failures: number) =>
      (nextCheckAfterFailure(now, { intervalSeconds: 3600, consecutiveFailures: failures, baseSeconds: 30 }, () => 0).getTime() -
        now.getTime()) /
      1000;
    expect([1, 2, 3, 4].map(delay)).toEqual([30, 60, 120, 240]);
    expect(delay(20)).toBe(3600);
  });

  it('honors a longer carrier Retry-After', () => {
    const at = nextCheckAfterFailure(now, { intervalSeconds: 3600, consecutiveFailures: 1, baseSeconds: 30, retryAfterSeconds: 300 }, () => 0);
    expect((at.getTime() - now.getTime()) / 1000).toBe(300);
  });
});
