import { Router } from 'express';
import type { QueueEvents } from 'bullmq';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { POLICY_STATUSES } from '../../domain/normalized-policy.js';
import { ApiError, conflict, notFound } from '../../lib/errors.js';
import type { CheckResult } from '../../monitoring/check-policy.js';
import { enrollPolicy } from '../../monitoring/enrollment.js';
import { enqueueCheck } from '../../queues/queues.js';
import { requireScope } from '../middleware.js';
import { serializeCheck, serializeEvent, serializePolicy, serializeSnapshot } from '../serializers.js';
import { BooleanParam, CursorParam, LimitParam, decodeCursor, requireId, toPage } from '../validation.js';

export function policiesRouter(deps: AppDeps, getQueueEvents: () => Promise<QueueEvents>): Router {
  const router = Router();
  const { prisma, config, carriers } = deps;

  const carrierId = z.string().refine((id) => carriers.has(id), {
    message: `must be one of: ${carriers.list().map((c) => c.carrierId).join(', ')}`,
  });
  const interval = z.number().int().min(config.monitoring.minCheckIntervalSeconds).max(7 * 86_400);

  const ListQuery = z.object({
    limit: LimitParam,
    cursor: CursorParam,
    carrierId: z.string().max(64).optional(),
    status: z.enum(POLICY_STATUSES).optional(),
  });

  const EnrollBody = z.strictObject({
    carrierId,
    externalPolicyId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'may contain letters, digits, ".", "_" and "-"'),
    checkIntervalSeconds: interval.optional(),
    monitoringEnabled: z.boolean().optional(),
  });

  const UpdateBody = z
    .strictObject({ checkIntervalSeconds: interval.optional(), monitoringEnabled: z.boolean().optional() })
    .refine((b) => Object.keys(b).length > 0, 'at least one field is required');

  const HistoryQuery = z.object({ limit: LimitParam, cursor: CursorParam, includeData: BooleanParam });
  const ChecksQuery = z.object({ limit: LimitParam, cursor: CursorParam });
  const CheckQuery = z.object({
    wait: BooleanParam,
    timeoutMs: z.coerce.number().int().min(100).max(30_000).default(15_000),
  });

  const loadPolicy = async (id: string | string[] | undefined) => {
    const policyId = requireId(id, 'pol', 'Policy');
    const policy = await prisma.policy.findUnique({ where: { id: policyId } });
    if (!policy) throw notFound('Policy', policyId);
    return policy;
  };

  router.get('/policies', requireScope('read'), async (req, res) => {
    const q = ListQuery.parse(req.query);
    const cursor = decodeCursor(q.cursor, 'string');
    const rows = await prisma.policy.findMany({
      where: { carrierId: q.carrierId, status: q.status, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
    res.json(toPage(rows, q.limit, (r) => r.id, serializePolicy));
  });

  router.post('/policies', requireScope('admin'), async (req, res) => {
    const body = EnrollBody.parse(req.body);
    const { policy, created } = await enrollPolicy(deps, body, res.locals.correlationId as string);
    if (!created) {
      throw conflict('POLICY_ALREADY_ENROLLED', 'This carrier policy is already enrolled', { policyId: policy.id });
    }
    res.status(201).location(`/policies/${policy.id}`).json(serializePolicy(policy));
  });

  router.get('/policies/:id', requireScope('read'), async (req, res) => {
    const policy = await loadPolicy(req.params.id);
    const snapshot =
      policy.currentVersion > 0
        ? await prisma.policySnapshot.findUnique({
            where: { policyId_version: { policyId: policy.id, version: policy.currentVersion } },
          })
        : null;
    res.json({ ...serializePolicy(policy), current: snapshot?.data ?? null });
  });

  router.patch('/policies/:id', requireScope('admin'), async (req, res) => {
    const policy = await loadPolicy(req.params.id);
    const body = UpdateBody.parse(req.body);
    const resumed = body.monitoringEnabled === true && !policy.monitoringEnabled;
    const updated = await prisma.policy.update({
      where: { id: policy.id },
      data: { ...body, ...(resumed ? { nextCheckAt: new Date() } : {}) },
    });
    res.json(serializePolicy(updated));
  });

  router.get('/policies/:id/history', requireScope('read'), async (req, res) => {
    const policy = await loadPolicy(req.params.id);
    const q = HistoryQuery.parse(req.query);
    const cursor = decodeCursor(q.cursor, 'number');
    const snapshots = await prisma.policySnapshot.findMany({
      where: { policyId: policy.id, ...(cursor !== undefined ? { version: { lt: cursor } } : {}) },
      orderBy: { version: 'desc' },
      take: q.limit + 1,
    });
    const versions = snapshots.map((s) => s.version);
    const events = await prisma.policyEvent.findMany({
      where: { policyId: policy.id, policyVersion: { in: versions } },
      orderBy: { id: 'asc' },
      select: { id: true, eventType: true, policyVersion: true },
    });
    const includeData = q.includeData ?? true;
    res.json(
      toPage(snapshots, q.limit, (s) => s.version, (s) => ({
        ...serializeSnapshot(s, { includeData }),
        events: events.filter((e) => e.policyVersion === s.version).map((e) => ({ id: e.id, eventType: e.eventType })),
      })),
    );
  });

  router.get('/policies/:id/checks', requireScope('read'), async (req, res) => {
    const policy = await loadPolicy(req.params.id);
    const q = ChecksQuery.parse(req.query);
    const cursor = decodeCursor(q.cursor, 'string');
    const checks = await prisma.policyCheck.findMany({
      where: { policyId: policy.id, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
    res.json(toPage(checks, q.limit, (c) => c.id, serializeCheck));
  });

  router.post('/policies/:id/check', requireScope('admin'), async (req, res) => {
    const policy = await loadPolicy(req.params.id);
    const q = CheckQuery.parse(req.query);
    const correlationId = res.locals.correlationId as string;
    const queueEvents = q.wait ? await getQueueEvents() : null;
    const job = await enqueueCheck(deps.queues, { policyId: policy.id, trigger: 'MANUAL', correlationId });

    if (!queueEvents) {
      res.status(202).json({ status: 'queued', jobId: job.id, policyId: policy.id });
      return;
    }

    let result: CheckResult;
    try {
      result = (await job.waitUntilFinished(queueEvents, q.timeoutMs)) as CheckResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(message)) {
        res.status(202).json({ status: 'queued', jobId: job.id, policyId: policy.id, note: 'check still running; poll /policies/:id/checks' });
        return;
      }
      throw new ApiError(500, 'CHECK_FAILED', 'The policy check job failed unexpectedly');
    }

    const [check, events] = await Promise.all([
      prisma.policyCheck.findUniqueOrThrow({ where: { id: result.checkId } }),
      prisma.policyEvent.findMany({ where: { id: { in: result.events.map((e) => e.id) } }, orderBy: { id: 'asc' } }),
    ]);
    res.json({ status: 'completed', check: serializeCheck(check), events: events.map(serializeEvent) });
  });

  return router;
}
