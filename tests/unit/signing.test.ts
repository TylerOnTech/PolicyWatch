import { describe, expect, it } from 'vitest';
import { computeSignature, signatureHeader, verifySignature } from '../../src/webhooks/signing.js';

const secret = 'whsec_test_secret_value_0123456789';
const body = JSON.stringify({ eventId: 'evt_example', eventType: 'POLICY_CANCELLED' });
const now = 1_793_145_600;

const verify = (overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
  verifySignature({
    body,
    signatureHeader: signatureHeader(secret, now, body),
    timestampHeader: String(now),
    secrets: secret,
    nowSeconds: now,
    ...overrides,
  });

describe('webhook signatures', () => {
  it('matches a known HMAC-SHA256 test vector over "<timestamp>.<body>"', () => {
    // Independently computable: printf '1793145600.{"a":1}' | openssl dgst -sha256 -hmac 'whsec_test_secret_value_0123456789'
    expect(computeSignature(secret, now, '{"a":1}')).toBe('153f715bee7b3346f2b41ccbd0fee41eb37f1df303ad581b5c8f760c2228e761');
    expect(computeSignature(secret, now, '{"a":1}')).not.toBe(computeSignature(secret, now + 1, '{"a":1}'));
  });

  it('verifies a valid signature', () => {
    expect(verify()).toEqual({ ok: true, timestamp: now });
  });

  it('rejects a tampered body', () => {
    expect(verify({ body: body.replace('CANCELLED', 'RENEWED') })).toEqual({ ok: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects the wrong secret', () => {
    expect(verify({ secrets: 'whsec_some_other_secret_00000000' })).toEqual({ ok: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects a replay outside the tolerance window, even with a valid signature', () => {
    expect(verify({ nowSeconds: now + 301 })).toEqual({ ok: false, reason: 'TIMESTAMP_OUTSIDE_TOLERANCE' });
    expect(verify({ nowSeconds: now - 301 })).toEqual({ ok: false, reason: 'TIMESTAMP_OUTSIDE_TOLERANCE' });
    expect(verify({ nowSeconds: now + 299 }).ok).toBe(true);
  });

  it('rejects a timestamp swapped onto an old signature (timestamp is inside the MAC)', () => {
    const later = now + 1000;
    expect(
      verify({ timestampHeader: String(later), nowSeconds: later, signatureHeader: signatureHeader(secret, now, body) }),
    ).toEqual({ ok: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('rejects missing or malformed headers', () => {
    expect(verify({ signatureHeader: undefined })).toEqual({ ok: false, reason: 'MISSING_HEADER' });
    expect(verify({ timestampHeader: 'yesterday' })).toEqual({ ok: false, reason: 'INVALID_TIMESTAMP' });
    expect(verify({ signatureHeader: 'v0=abc' })).toEqual({ ok: false, reason: 'NO_V1_SIGNATURE' });
    expect(verify({ signatureHeader: 'v1=not-hex' })).toEqual({ ok: false, reason: 'SIGNATURE_MISMATCH' });
  });

  it('supports secret rotation: several v1 signatures and several candidate secrets', () => {
    const oldSecret = 'whsec_old_secret_value_00000000000';
    const header = `${signatureHeader(oldSecret, now, body)}, ${signatureHeader(secret, now, body)}`;
    expect(verify({ signatureHeader: header }).ok).toBe(true);
    expect(verify({ signatureHeader: signatureHeader(oldSecret, now, body), secrets: [secret, oldSecret] }).ok).toBe(true);
  });
});
