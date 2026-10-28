import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature scheme (documented in docs/webhooks.md):
 *
 *   signed_payload = `${timestamp}.${raw_body}`
 *   signature      = hex(HMAC-SHA256(secret, signed_payload))
 *   header         = `PolicyWatch-Signature: v1=<signature>`  (several comma-separated during rotation)
 *
 * Binding the timestamp into the MAC lets receivers reject replays older than a tolerance window.
 */
export const HEADERS = {
  signature: 'policywatch-signature',
  timestamp: 'policywatch-timestamp',
  eventId: 'policywatch-event-id',
  eventType: 'policywatch-event-type',
  deliveryId: 'policywatch-delivery-id',
  attempt: 'policywatch-attempt',
} as const;

export const DEFAULT_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `v1=${computeSignature(secret, timestamp, body)}`;
}

export type VerificationFailure =
  | 'MISSING_HEADER'
  | 'INVALID_TIMESTAMP'
  | 'TIMESTAMP_OUTSIDE_TOLERANCE'
  | 'NO_V1_SIGNATURE'
  | 'SIGNATURE_MISMATCH';

export type VerificationResult = { ok: true; timestamp: number } | { ok: false; reason: VerificationFailure };

/**
 * Receiver-side verification. `body` must be the exact raw request body (bytes as received, before
 * any JSON parsing/re-serialization). Accepts any of several secrets to support rotation.
 */
export function verifySignature(input: {
  body: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secrets: string | string[];
  toleranceSeconds?: number;
  nowSeconds?: number;
}): VerificationResult {
  const { body, signatureHeader: sigHeader, timestampHeader } = input;
  if (!sigHeader || !timestampHeader) return { ok: false, reason: 'MISSING_HEADER' };
  if (!/^\d{1,12}$/.test(timestampHeader)) return { ok: false, reason: 'INVALID_TIMESTAMP' };

  const timestamp = Number(timestampHeader);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: 'TIMESTAMP_OUTSIDE_TOLERANCE' };

  const candidates = sigHeader
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3));
  if (candidates.length === 0) return { ok: false, reason: 'NO_V1_SIGNATURE' };

  const secrets = Array.isArray(input.secrets) ? input.secrets : [input.secrets];
  for (const secret of secrets) {
    const expected = Buffer.from(computeSignature(secret, timestamp, body), 'hex');
    for (const candidate of candidates) {
      if (!/^[0-9a-f]{64}$/i.test(candidate)) continue;
      const provided = Buffer.from(candidate, 'hex');
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        return { ok: true, timestamp };
      }
    }
  }
  return { ok: false, reason: 'SIGNATURE_MISMATCH' };
}
