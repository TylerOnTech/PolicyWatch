import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { safeEqual } from '../../lib/crypto.js';
import { renderAcme, renderBluebird, renderCardinal, renderCardinalStatus } from './renderers.js';
import { SimStore, applyMutation, seedPolicies, type FaultMode, type SimCarrierId } from './store.js';

export interface CarrierSimOptions {
  acmeApiKey: string;
  bluebirdToken: string;
  cardinalUsername: string;
  cardinalPassword: string;
  /** How long the "timeout" fault stalls before answering. */
  timeoutDelayMs: number;
  store?: SimStore;
}

const FAULT_MODES = [
  'none',
  'http_500',
  'http_503',
  'timeout',
  'rate_limited',
  'data_unavailable',
  'malformed',
  'not_found',
  'auth_error',
] as const satisfies readonly FaultMode[];

const CoverageInput = z.object({
  type: z.enum([
    'BODILY_INJURY_LIABILITY',
    'PROPERTY_DAMAGE_LIABILITY',
    'UNINSURED_MOTORIST_BI',
    'MEDICAL_PAYMENTS',
    'COLLISION',
    'COMPREHENSIVE',
    'RENTAL_REIMBURSEMENT',
    'ROADSIDE_ASSISTANCE',
  ]),
  perPersonCents: z.number().int().nonnegative().optional(),
  perOccurrenceCents: z.number().int().nonnegative().optional(),
  deductibleCents: z.number().int().nonnegative().optional(),
});

const MutationSchema = z.strictObject({
  status: z.enum(['ACTIVE', 'PENDING', 'CANCELLED', 'EXPIRED']).optional(),
  premiumCents: z.number().int().nonnegative().optional(),
  addVehicle: z
    .object({
      vin: z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/),
      year: z.number().int(),
      make: z.string().min(1),
      model: z.string().min(1),
      coverages: z.array(CoverageInput).optional(),
    })
    .optional(),
  removeVehicleVin: z.string().optional(),
  setCoverage: CoverageInput.extend({ vehicleVin: z.string().optional() }).optional(),
  removeCoverage: z.object({ type: CoverageInput.shape.type, vehicleVin: z.string().optional() }).optional(),
  renew: z.object({ termMonths: z.number().int().min(1).max(24).optional(), premiumCents: z.number().int().optional() }).optional(),
  insuredEmail: z.email().optional(),
});

/**
 * Simulated carrier APIs (for local development, tests and the demo). Three carriers with different
 * transports, auth schemes and payload shapes, plus an admin API to mutate policies and inject faults.
 * Never expose this service publicly.
 */
export function createCarrierSimApp(opts: CarrierSimOptions): { app: Express; store: SimStore; clearTimers: () => void } {
  const store = opts.store ?? new SimStore();
  const app = express();
  app.disable('x-powered-by');
  const pendingTimers = new Set<NodeJS.Timeout>();

  /** Applies an injected fault. Returns true if the response has been handled. */
  const applyFault = async (carrierId: SimCarrierId, res: Response): Promise<boolean | 'continue-after-delay'> => {
    const mode = store.takeFault(carrierId);
    const xml = carrierId === 'cardinal';
    const sendError = (status: number, code: string, headers: Record<string, string> = {}) => {
      res.status(status).set(headers);
      if (xml) res.type('application/xml').send(renderCardinalStatus(code, 'Simulated fault'));
      else res.json({ error: code });
    };
    switch (mode) {
      case 'none':
        return false;
      case 'http_500':
        sendError(500, 'INTERNAL_SERVER_ERROR');
        return true;
      case 'http_503':
        sendError(503, 'SERVICE_UNAVAILABLE', { 'Retry-After': '30' });
        return true;
      case 'rate_limited':
        sendError(429, 'RATE_LIMITED', { 'Retry-After': '60' });
        return true;
      case 'auth_error':
        sendError(401, 'UNAUTHORIZED');
        return true;
      case 'timeout':
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            pendingTimers.delete(t);
            resolve();
          }, opts.timeoutDelayMs);
          pendingTimers.add(t);
          res.on('close', () => {
            clearTimeout(t);
            pendingTimers.delete(t);
            resolve();
          });
        });
        return res.writableEnded || res.destroyed ? true : 'continue-after-delay';
      case 'not_found':
        if (carrierId === 'cardinal') res.type('application/xml').send(renderCardinalStatus('NOT_FOUND', 'No such policy'));
        else res.status(404).json({ error: 'POLICY_NOT_FOUND' });
        return true;
      case 'data_unavailable':
        if (carrierId === 'bluebird') res.json({ status: 'processing', data: null, retry_after_seconds: 30 });
        else if (carrierId === 'cardinal') res.type('application/xml').send(renderCardinalStatus('DATA_UNAVAILABLE', 'Policy system maintenance'));
        else sendError(503, 'POLICY_SYSTEM_MAINTENANCE', { 'Retry-After': '120' });
        return true;
      case 'malformed':
        if (carrierId === 'cardinal') res.type('application/xml').send('<PolicyInquiryRs><MsgStatus><StatusCd>SUCCESS');
        else if (carrierId === 'bluebird') res.json({ status: 'ok', data: { policy_id: 'BB-?', policy_state: 'active' } });
        else res.type('application/json').send('{"policy": {"policyNumber": "ACM-');
        return true;
    }
  };

  const sendPolicy = async (carrierId: SimCarrierId, policyNumber: string, res: Response) => {
    if ((await applyFault(carrierId, res)) === true) return;
    const policy = store.get(carrierId, policyNumber);
    if (!policy) {
      if (carrierId === 'cardinal') res.type('application/xml').send(renderCardinalStatus('NOT_FOUND', 'No such policy'));
      else res.status(404).json({ error: 'POLICY_NOT_FOUND' });
      return;
    }
    const variant = store.nextVariant(carrierId, policyNumber);
    if (carrierId === 'acme') res.json(renderAcme(policy, variant));
    else if (carrierId === 'bluebird') res.json(renderBluebird(policy, variant));
    else res.type('application/xml').send(renderCardinal(policy, variant));
  };

  // Acme Mutual — GET with API key header
  app.get('/acme/v2/policies/:policyNumber', async (req, res) => {
    if (!safeEqual(req.header('x-api-key') ?? '', opts.acmeApiKey)) return void res.status(401).json({ error: 'INVALID_API_KEY' });
    await sendPolicy('acme', req.params.policyNumber, res);
  });

  // Bluebird — GET with bearer token and query parameter
  app.get('/bluebird/api/v1/policy', async (req, res) => {
    if (!safeEqual(req.header('authorization') ?? '', `Bearer ${opts.bluebirdToken}`)) {
      return void res.status(401).json({ status: 'error', error: 'invalid_token' });
    }
    const id = typeof req.query.policy_id === 'string' ? req.query.policy_id : '';
    if (!id) return void res.status(400).json({ status: 'error', error: 'policy_id is required' });
    await sendPolicy('bluebird', id, res);
  });

  // Cardinal — POST XML inquiry with basic auth
  app.post('/cardinal/PolicyInquiry', express.text({ type: ['application/xml', 'text/xml'], limit: '16kb' }), async (req: Request, res) => {
    const expected = `Basic ${Buffer.from(`${opts.cardinalUsername}:${opts.cardinalPassword}`).toString('base64')}`;
    if (!safeEqual(req.header('authorization') ?? '', expected)) {
      return void res.status(401).type('application/xml').send(renderCardinalStatus('AUTH_FAILED', 'Invalid credentials'));
    }
    const match = /<PolicyNumber>([^<]{1,64})<\/PolicyNumber>/.exec(typeof req.body === 'string' ? req.body : '');
    if (!match) return void res.status(400).type('application/xml').send(renderCardinalStatus('BAD_REQUEST', 'PolicyNumber is required'));
    await sendPolicy('cardinal', match[1]!.trim(), res);
  });

  // ---------------------------------------------------------------- admin (demo/test control plane)
  const admin = express.Router();
  admin.use(express.json());

  admin.get('/policies', (_req, res) => {
    res.json({ data: store.list(), faults: store.getFaults(), noise: store.noise });
  });

  admin.get('/policies/:carrierId/:policyNumber', (req, res) => {
    const policy = store.get(req.params.carrierId, req.params.policyNumber);
    if (!policy) return void res.status(404).json({ error: 'not found' });
    res.json(policy);
  });

  // Clone a seeded policy under a new number (lets the demo start from a fresh, ACTIVE policy each run).
  admin.post('/policies', (req, res) => {
    const parsed = z
      .object({
        carrierId: z.enum(['acme', 'bluebird', 'cardinal']),
        policyNumber: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,40}$/),
        templatePolicyNumber: z.string().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
    const { carrierId, policyNumber, templatePolicyNumber } = parsed.data;
    if (store.get(carrierId, policyNumber)) return void res.status(409).json({ error: 'policy exists' });
    const template = templatePolicyNumber
      ? store.get(carrierId, templatePolicyNumber)
      : seedPolicies().find((p) => p.carrierId === carrierId);
    if (!template) return void res.status(404).json({ error: 'template not found' });
    const created = { ...structuredClone(template), policyNumber, status: 'ACTIVE' as const };
    store.put(created);
    res.status(201).json(created);
  });

  admin.patch('/policies/:carrierId/:policyNumber', (req, res) => {
    const policy = store.get(req.params.carrierId, req.params.policyNumber);
    if (!policy) return void res.status(404).json({ error: 'not found' });
    const parsed = MutationSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid mutation', issues: parsed.error.issues });
    const updated = applyMutation(policy, parsed.data);
    store.put(updated);
    res.json(updated);
  });

  admin.post('/faults', (req, res) => {
    const parsed = z
      .object({
        carrierId: z.enum(['acme', 'bluebird', 'cardinal']),
        mode: z.enum(FAULT_MODES),
        remaining: z.number().int().positive().nullable().default(null),
      })
      .safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid fault', issues: parsed.error.issues });
    store.setFault(parsed.data.carrierId, { mode: parsed.data.mode, remaining: parsed.data.remaining });
    res.json({ faults: store.getFaults() });
  });

  admin.post('/noise', (req, res) => {
    store.noise = Boolean((req.body as { enabled?: unknown })?.enabled);
    res.json({ noise: store.noise });
  });

  admin.post('/reset', (_req, res) => {
    store.reset();
    res.json({ reset: true });
  });

  app.use('/_admin', admin);
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', policies: store.list().length });
  });

  return { app, store, clearTimers: () => pendingTimers.forEach(clearTimeout) };
}
