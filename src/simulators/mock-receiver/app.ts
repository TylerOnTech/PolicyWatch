import express, { type Express } from 'express';
import { z } from 'zod';
import { HEADERS, verifySignature } from '../../webhooks/signing.js';

export type ReceiverMode = 'ok' | 'fail' | 'timeout' | 'flaky';

export interface ReceivedWebhook {
  receivedAt: string;
  eventId: string | null;
  eventType: string | null;
  deliveryId: string | null;
  attempt: number | null;
  signatureValid: boolean;
  verificationError: string | null;
  duplicate: boolean;
  respondedWith: number | 'timeout';
}

export interface ReceiverState {
  mode: ReceiverMode;
  failStatus: number;
  failRemaining: number;
  delayMs: number;
  secrets: string[];
  received: ReceivedWebhook[];
  processedEventIds: Set<string>;
}

/**
 * A reference webhook consumer, used in the demo and tests. It does what a real consumer should:
 *   1. verify the HMAC signature over the *raw* body,
 *   2. reject timestamps outside a 5-minute window (replay protection),
 *   3. de-duplicate on eventId (deliveries are at-least-once),
 * and can be switched into failure modes to exercise PolicyWatch's retry logic.
 */
export function createMockReceiverApp(opts: { secrets?: string[]; toleranceSeconds?: number } = {}): {
  app: Express;
  state: ReceiverState;
} {
  const state: ReceiverState = {
    mode: 'ok',
    failStatus: 503,
    failRemaining: 0,
    delayMs: 15_000,
    secrets: opts.secrets ?? [],
    received: [],
    processedEventIds: new Set(),
  };
  const app = express();
  app.disable('x-powered-by');

  // Keep the body as the exact string received: re-serializing parsed JSON would break the signature.
  app.post('/webhooks', express.text({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    const verification = verifySignature({
      body: raw,
      signatureHeader: req.header(HEADERS.signature),
      timestampHeader: req.header(HEADERS.timestamp),
      secrets: state.secrets,
      toleranceSeconds: opts.toleranceSeconds,
    });

    let eventId: string | null = null;
    let eventType: string | null = null;
    if (verification.ok) {
      try {
        const parsed = JSON.parse(raw) as { eventId?: string; eventType?: string };
        eventId = parsed.eventId ?? null;
        eventType = parsed.eventType ?? null;
      } catch {
        // signed but not JSON: treated as a bad request below
      }
    }

    const record: ReceivedWebhook = {
      receivedAt: new Date().toISOString(),
      eventId,
      eventType,
      deliveryId: req.header(HEADERS.deliveryId) ?? null,
      attempt: Number(req.header(HEADERS.attempt)) || null,
      signatureValid: verification.ok,
      verificationError: verification.ok ? null : verification.reason,
      duplicate: eventId !== null && state.processedEventIds.has(eventId),
      respondedWith: 200,
    };
    state.received.push(record);
    if (state.received.length > 500) state.received.shift();

    if (!verification.ok) {
      record.respondedWith = 401;
      return void res.status(401).json({ error: 'invalid signature', reason: verification.reason });
    }

    if (state.mode === 'fail' || (state.mode === 'flaky' && state.failRemaining > 0)) {
      if (state.mode === 'flaky') state.failRemaining -= 1;
      record.respondedWith = state.failStatus;
      return void res.status(state.failStatus).json({ error: 'simulated failure' });
    }
    if (state.mode === 'timeout') {
      record.respondedWith = 'timeout';
      await new Promise((r) => setTimeout(r, state.delayMs));
      if (!res.writableEnded && !res.destroyed) res.status(200).json({ received: true, late: true });
      return;
    }

    if (eventId) state.processedEventIds.add(eventId);
    res.status(200).json({ received: true, duplicate: record.duplicate });
  });

  const control = express.Router();
  control.use(express.json());

  control.get('/state', (_req, res) => {
    res.json({
      mode: state.mode,
      failStatus: state.failStatus,
      failRemaining: state.failRemaining,
      secretsConfigured: state.secrets.length,
      received: state.received,
      uniqueEventsProcessed: state.processedEventIds.size,
    });
  });

  control.post('/mode', (req, res) => {
    const parsed = z
      .object({
        mode: z.enum(['ok', 'fail', 'timeout', 'flaky']),
        status: z.number().int().min(300).max(599).optional(),
        failCount: z.number().int().min(0).max(100).optional(),
        delayMs: z.number().int().min(0).max(120_000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid mode', issues: parsed.error.issues });
    state.mode = parsed.data.mode;
    state.failStatus = parsed.data.status ?? 503;
    state.failRemaining = parsed.data.failCount ?? 0;
    if (parsed.data.delayMs !== undefined) state.delayMs = parsed.data.delayMs;
    res.json({ mode: state.mode, failStatus: state.failStatus, failRemaining: state.failRemaining });
  });

  control.post('/secrets', (req, res) => {
    const parsed = z.object({ secrets: z.array(z.string().min(16)).min(1).max(5) }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid secrets' });
    state.secrets = parsed.data.secrets;
    res.json({ secretsConfigured: state.secrets.length });
  });

  control.post('/reset', (_req, res) => {
    state.mode = 'ok';
    state.failStatus = 503;
    state.failRemaining = 0;
    state.received = [];
    state.processedEventIds.clear();
    res.json({ reset: true });
  });

  app.use('/_control', control);
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  return { app, state };
}
