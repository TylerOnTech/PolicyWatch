import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { canonicalJson } from '../../src/lib/canonical-json.js';
import { decryptSecret, encryptSecret, generateWebhookSecret, safeEqual } from '../../src/lib/crypto.js';
import { isValidId, newId } from '../../src/lib/ids.js';
import { eventDedupeKey } from '../../src/domain/events.js';
import { subscriptionMatches } from '../../src/webhooks/subscriptions.js';

describe('canonicalJson', () => {
  it('is independent of key insertion order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null }, z: undefined })).toBe('{"a":{"c":null,"d":[1,2]},"b":1}');
    expect(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: [1, 2], c: null } }));
  });

  it('preserves array order (arrays are sorted semantically before hashing, not here)', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('rejects values JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });
});

describe('secret encryption at rest', () => {
  const key = randomBytes(32);

  it('round-trips and uses a fresh IV each time', () => {
    const secret = generateWebhookSecret();
    const a = encryptSecret(secret, key);
    const b = encryptSecret(secret, key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe(secret);
    expect(a).not.toContain(secret);
  });

  it('detects tampering (GCM auth tag) and wrong keys', () => {
    const enc = encryptSecret('whsec_abc', key);
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
  });

  it('safeEqual compares in constant time irrespective of length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('ids', () => {
  it('are prefixed, valid and strictly increasing within a process', () => {
    const ids = Array.from({ length: 1_000 }, () => newId('evt'));
    expect(ids.every((id) => isValidId(id, 'evt'))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(isValidId(ids[0]!, 'pol')).toBe(false);
  });
});

describe('domain helpers', () => {
  it('dedupe keys are deterministic per policy version, type and discriminator', () => {
    expect(eventDedupeKey('pol_x', 3, { type: 'VEHICLE_ADDED', discriminator: 'VIN1' })).toBe('pol_x:v3:VEHICLE_ADDED:VIN1');
  });

  it('subscription filters match on event type (or *) and optional carrier list', () => {
    const event = { eventType: 'POLICY_CANCELLED', carrierId: 'acme' };
    expect(subscriptionMatches({ eventTypes: ['*'], carrierIds: [] }, event)).toBe(true);
    expect(subscriptionMatches({ eventTypes: ['POLICY_CANCELLED'], carrierIds: ['acme'] }, event)).toBe(true);
    expect(subscriptionMatches({ eventTypes: ['POLICY_RENEWED'], carrierIds: [] }, event)).toBe(false);
    expect(subscriptionMatches({ eventTypes: ['*'], carrierIds: ['bluebird'] }, event)).toBe(false);
  });
});

describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgresql://x',
    ADMIN_API_KEY: 'a'.repeat(32),
    SECRET_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };

  it('requires strong keys and reports every problem at once', () => {
    expect(() => loadConfig({ DATABASE_URL: '', ADMIN_API_KEY: 'short', SECRET_ENCRYPTION_KEY: 'x' })).toThrow(
      /DATABASE_URL[\s\S]*ADMIN_API_KEY[\s\S]*SECRET_ENCRYPTION_KEY/,
    );
  });

  it('defaults to requiring https webhooks in production only', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).webhooks.requireHttps).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).webhooks.requireHttps).toBe(false);
  });

  it('derives carrier URLs from the simulator base URL', () => {
    const cfg = loadConfig({ ...base, CARRIER_SIM_BASE_URL: 'http://sim:4000/' });
    expect(cfg.carriers.acme.baseUrl).toBe('http://sim:4000/acme');
    expect(cfg.carriers.cardinal.baseUrl).toBe('http://sim:4000/cardinal');
  });
});
