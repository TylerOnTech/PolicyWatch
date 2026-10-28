import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { notFound } from '../../lib/errors.js';
import { requestRedelivery } from '../../webhooks/delivery-service.js';
import { requireScope } from '../middleware.js';
import { serializeAttempt, serializeDelivery } from '../serializers.js';
import { CursorParam, LimitParam, decodeCursor, requireId, toPage } from '../validation.js';

export function deliveriesRouter(deps: AppDeps): Router {
  const router = Router();
  const { prisma } = deps;

  const ListQuery = z.object({
    limit: LimitParam,
    cursor: CursorParam,
    subscriptionId: z.string().max(64).optional(),
    eventId: z.string().max(64).optional(),
    status: z.enum(['PENDING', 'IN_PROGRESS', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED']).optional(),
  });

  const eventSummary = { select: { eventType: true, policyId: true } } as const;

  router.get('/deliveries', requireScope('read'), async (req, res) => {
    const q = ListQuery.parse(req.query);
    const cursor = decodeCursor(q.cursor, 'string');
    const rows = await prisma.webhookDelivery.findMany({
      where: {
        subscriptionId: q.subscriptionId,
        eventId: q.eventId,
        status: q.status,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      include: { event: eventSummary },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
    res.json(toPage(rows, q.limit, (r) => r.id, serializeDelivery));
  });

  router.get('/deliveries/:id', requireScope('read'), async (req, res) => {
    const id = requireId(req.params.id, 'dlv', 'Delivery');
    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id },
      include: { event: eventSummary, attempts: { orderBy: { attemptNumber: 'asc' } } },
    });
    if (!delivery) throw notFound('Delivery', id);
    res.json({ ...serializeDelivery(delivery), attempts: delivery.attempts.map(serializeAttempt) });
  });

  router.post('/deliveries/:id/retry', requireScope('admin'), async (req, res) => {
    const id = requireId(req.params.id, 'dlv', 'Delivery');
    const delivery = await requestRedelivery(deps, id, res.locals.correlationId as string);
    res.status(202).json(serializeDelivery(delivery));
  });

  return router;
}
