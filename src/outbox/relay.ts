import type { AppDeps } from '../deps.js';
import { newId } from '../lib/ids.js';
import { subscriptionMatches } from '../webhooks/subscriptions.js';

export interface RelayResult {
  messages: number;
  deliveriesCreated: number;
  /** True when the batch was full, i.e. more work is probably waiting. */
  saturated: boolean;
}

/**
 * Drains the transactional outbox: for each pending event, creates one WebhookDelivery per matching
 * active subscription and marks the outbox row processed — atomically. Delivery jobs are enqueued
 * only after commit.
 *
 * Failure modes:
 *  - crash before commit → nothing changed, the rows are re-read next tick;
 *  - crash after commit but before enqueue → deliveries exist without jobs; the sweeper re-enqueues;
 *  - concurrent relays → `SKIP LOCKED` partitions rows; UNIQUE(subscription_id, event_id) plus
 *    `skipDuplicates` makes fan-out idempotent even if a message were somehow processed twice.
 */
export async function relayOutbox(
  deps: Pick<AppDeps, 'prisma' | 'queues' | 'config' | 'logger' | 'metrics'>,
): Promise<RelayResult> {
  const { batchSize } = deps.config.outbox;

  const result = await deps.prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; event_id: string }>>`
        SELECT id, event_id FROM outbox_messages
         WHERE status = 'PENDING' AND available_at <= now()
         ORDER BY created_at, id
         LIMIT ${batchSize}
         FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return { messages: 0, deliveries: [] as Array<{ id: string; correlationId: string }> };

      const [events, subscriptions] = await Promise.all([
        tx.policyEvent.findMany({
          where: { id: { in: rows.map((r) => r.event_id) } },
          select: { id: true, eventType: true, carrierId: true, correlationId: true },
        }),
        tx.webhookSubscription.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, eventTypes: true, carrierIds: true },
        }),
      ]);

      const now = new Date();
      const planned = events.flatMap((event) =>
        subscriptions
          .filter((sub) => subscriptionMatches(sub, event))
          .map((sub) => ({
            row: {
              id: newId('dlv'),
              subscriptionId: sub.id,
              eventId: event.id,
              maxAttempts: deps.config.webhooks.maxAttempts,
              enqueuedAt: now,
            },
            correlationId: event.correlationId ?? event.id,
          })),
      );

      const inserted =
        planned.length > 0
          ? await tx.webhookDelivery.createManyAndReturn({
              data: planned.map((p) => p.row),
              skipDuplicates: true,
              select: { id: true },
            })
          : [];
      const insertedIds = new Set(inserted.map((d) => d.id));

      await tx.outboxMessage.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { status: 'PROCESSED', processedAt: now, attempts: { increment: 1 } },
      });

      return {
        messages: rows.length,
        deliveries: planned
          .filter((p) => insertedIds.has(p.row.id))
          .map((p) => ({ id: p.row.id, correlationId: p.correlationId })),
      };
    },
    { maxWait: 5_000, timeout: 15_000 },
  );

  if (result.deliveries.length > 0) {
    try {
      await deps.queues.deliveries.addBulk(
        result.deliveries.map((d) => ({
          name: 'deliver',
          data: { deliveryId: d.id, trigger: 'AUTOMATIC' as const, correlationId: d.correlationId },
          opts: { jobId: `${d.id}-a1` },
        })),
      );
    } catch (err) {
      deps.logger.warn({ err, count: result.deliveries.length }, 'delivery enqueue failed after outbox commit; sweeper will recover');
    }
  }

  if (result.messages > 0) {
    deps.metrics.outboxRelayed.inc({ result: 'processed' }, result.messages);
    deps.logger.info({ messages: result.messages, deliveries: result.deliveries.length }, 'outbox batch relayed');
  }
  return { messages: result.messages, deliveriesCreated: result.deliveries.length, saturated: result.messages === batchSize };
}
