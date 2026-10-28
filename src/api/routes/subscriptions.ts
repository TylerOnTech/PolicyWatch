import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../deps.js';
import { EVENT_TYPES } from '../../domain/events.js';
import { conflict, notFound } from '../../lib/errors.js';
import { ALL_EVENTS, assertDeliverableUrl, createSubscription } from '../../webhooks/subscriptions.js';
import { requireScope } from '../middleware.js';
import { serializeSubscription } from '../serializers.js';
import { CursorParam, LimitParam, decodeCursor, requireId, toPage } from '../validation.js';

export function subscriptionsRouter(deps: AppDeps): Router {
  const router = Router();
  const { prisma, carriers } = deps;

  const eventTypes = z
    .array(z.enum([...EVENT_TYPES, ALL_EVENTS]))
    .min(1)
    .max(EVENT_TYPES.length + 1);
  const carrierIds = z
    .array(z.string().refine((id) => carriers.has(id), 'unknown carrierId'))
    .max(20);
  const url = z.string().trim().min(1).max(2048);
  const description = z.string().trim().max(500).nullable();

  const CreateBody = z.strictObject({
    url,
    eventTypes,
    carrierIds: carrierIds.default([]),
    description: description.optional(),
  });

  const UpdateBody = z
    .strictObject({
      url: url.optional(),
      eventTypes: eventTypes.optional(),
      carrierIds: carrierIds.optional(),
      description: description.optional(),
      active: z.boolean().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'at least one field is required');

  const ListQuery = z.object({
    limit: LimitParam,
    cursor: CursorParam,
    status: z.enum(['ACTIVE', 'INACTIVE', 'DELETED']).optional(),
  });

  const load = async (raw: string | string[] | undefined) => {
    const id = requireId(raw, 'sub', 'Subscription');
    const sub = await prisma.webhookSubscription.findUnique({ where: { id } });
    if (!sub) throw notFound('Subscription', id);
    return sub;
  };

  /** Deactivation/deletion stops queued work now rather than letting each job discover it later. */
  const cancelOutstanding = (subscriptionId: string, reason: string) =>
    prisma.webhookDelivery.updateMany({
      where: { subscriptionId, status: { in: ['PENDING', 'RETRY_SCHEDULED'] } },
      data: { status: 'CANCELLED', lastError: reason },
    });

  router.post('/subscriptions', requireScope('admin'), async (req, res) => {
    const body = CreateBody.parse(req.body);
    const { subscription, secret } = await createSubscription(deps, body);
    deps.logger.info({ subscriptionId: subscription.id, eventTypes: subscription.eventTypes }, 'subscription created');
    res
      .status(201)
      .location(`/subscriptions/${subscription.id}`)
      .json({ ...serializeSubscription(subscription), secret });
  });

  router.get('/subscriptions', requireScope('read'), async (req, res) => {
    const q = ListQuery.parse(req.query);
    const cursor = decodeCursor(q.cursor, 'string');
    const rows = await prisma.webhookSubscription.findMany({
      where: { status: q.status ?? { not: 'DELETED' }, ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
    res.json(toPage(rows, q.limit, (r) => r.id, serializeSubscription));
  });

  router.get('/subscriptions/:id', requireScope('read'), async (req, res) => {
    res.json(serializeSubscription(await load(req.params.id)));
  });

  router.patch('/subscriptions/:id', requireScope('admin'), async (req, res) => {
    const sub = await load(req.params.id);
    if (sub.status === 'DELETED') throw conflict('SUBSCRIPTION_DELETED', 'Deleted subscriptions cannot be modified');
    const body = UpdateBody.parse(req.body);
    if (body.url && body.url !== sub.url) await assertDeliverableUrl(deps, body.url);

    const { active, ...fields } = body;
    const status = active === undefined ? sub.status : active ? 'ACTIVE' : 'INACTIVE';
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.webhookSubscription.update({
        where: { id: sub.id },
        data: {
          ...fields,
          ...(fields.eventTypes ? { eventTypes: [...new Set(fields.eventTypes)].sort() } : {}),
          ...(fields.carrierIds ? { carrierIds: [...new Set(fields.carrierIds)].sort() } : {}),
          status,
        },
      });
      if (status === 'INACTIVE' && sub.status === 'ACTIVE') {
        await tx.webhookDelivery.updateMany({
          where: { subscriptionId: sub.id, status: { in: ['PENDING', 'RETRY_SCHEDULED'] } },
          data: { status: 'CANCELLED', lastError: 'Subscription deactivated' },
        });
      }
      return result;
    });
    deps.logger.info({ subscriptionId: sub.id, status }, 'subscription updated');
    res.json(serializeSubscription(updated));
  });

  router.delete('/subscriptions/:id', requireScope('admin'), async (req, res) => {
    const sub = await load(req.params.id);
    if (sub.status !== 'DELETED') {
      // Soft delete: delivery history stays auditable.
      await prisma.webhookSubscription.update({ where: { id: sub.id }, data: { status: 'DELETED' } });
      await cancelOutstanding(sub.id, 'Subscription deleted');
      deps.logger.info({ subscriptionId: sub.id }, 'subscription deleted');
    }
    res.status(204).end();
  });

  return router;
}
