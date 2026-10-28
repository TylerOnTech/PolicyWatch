import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { EVENT_TYPES } from '../../domain/events.js';
import { notFound } from '../../lib/errors.js';
import { requireScope } from '../middleware.js';
import { serializeEvent } from '../serializers.js';
import { CursorParam, LimitParam, decodeCursor, requireId, toPage } from '../validation.js';

export function eventsRouter(deps: AppDeps): Router {
  const router = Router();
  const { prisma } = deps;

  const ListQuery = z.object({
    limit: LimitParam,
    cursor: CursorParam,
    policyId: z.string().max(64).optional(),
    carrierId: z.string().max(64).optional(),
    eventType: z.enum(EVENT_TYPES).optional(),
    since: z.iso.datetime().optional(),
  });

  router.get('/events', requireScope('read'), async (req, res) => {
    const q = ListQuery.parse(req.query);
    const cursor = decodeCursor(q.cursor, 'string');
    const rows = await prisma.policyEvent.findMany({
      where: {
        policyId: q.policyId,
        carrierId: q.carrierId,
        eventType: q.eventType,
        ...(q.since ? { occurredAt: { gte: new Date(q.since) } } : {}),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
    res.json(toPage(rows, q.limit, (r) => r.id, serializeEvent));
  });

  router.get('/events/:id', requireScope('read'), async (req, res) => {
    const id = requireId(req.params.id, 'evt', 'Event');
    const event = await prisma.policyEvent.findUnique({
      where: { id },
      include: {
        deliveries: {
          select: { id: true, subscriptionId: true, status: true, attemptCount: true, succeededAt: true },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!event) throw notFound('Event', id);
    const { deliveries, ...rest } = event;
    res.json({
      ...serializeEvent(rest),
      deliveries: deliveries.map((d) => ({ ...d, succeededAt: d.succeededAt?.toISOString() ?? null })),
    });
  });

  return router;
}
