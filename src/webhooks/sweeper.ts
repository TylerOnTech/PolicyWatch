import type { AppDeps } from '../deps.js';

/**
 * Recovery for deliveries whose queue job went missing: Redis data loss, a crash between a database
 * commit and the enqueue, or a worker that died while holding a delivery lock. PostgreSQL is the
 * source of truth; the queue is only a trigger, so re-enqueueing is always safe (the claim in
 * processDelivery prevents double sends).
 */
export async function sweepStuckDeliveries(
  deps: Pick<AppDeps, 'prisma' | 'queues' | 'config' | 'logger' | 'metrics'>,
  opts: { limit?: number } = {},
): Promise<number> {
  const staleMs = deps.config.webhooks.sweeperStaleAfterMs;
  const limit = opts.limit ?? 200;

  const rows = await deps.prisma.$queryRaw<Array<{ id: string; status: string }>>`
    UPDATE webhook_deliveries d
       SET enqueued_at = now(), updated_at = now()
      FROM (
        SELECT id FROM webhook_deliveries
         WHERE (
                 -- overdue and not (re-)enqueued recently
                 status IN ('PENDING', 'RETRY_SCHEDULED')
                 AND next_attempt_at < now() - (${staleMs} * interval '1 millisecond')
                 AND (enqueued_at IS NULL OR enqueued_at < now() - (${staleMs} * interval '1 millisecond'))
               )
            OR (
                 -- claimed by a worker that died; not re-enqueued since its lock expired
                 status = 'IN_PROGRESS'
                 AND locked_until < now()
                 AND (enqueued_at IS NULL OR enqueued_at < locked_until)
               )
         ORDER BY next_attempt_at
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      ) stuck
     WHERE d.id = stuck.id
    RETURNING d.id, d.status::text AS status`;

  if (rows.length === 0) return 0;
  const stamp = Date.now();
  await deps.queues.deliveries.addBulk(
    rows.map((r) => ({
      name: 'deliver',
      data: { deliveryId: r.id, trigger: 'AUTOMATIC' as const, correlationId: `sweeper-${stamp}` },
      opts: { jobId: `${r.id}-r${stamp}` },
    })),
  );
  for (const r of rows) deps.metrics.sweeperRecovered.inc({ kind: r.status });
  deps.logger.warn({ count: rows.length }, 'sweeper re-enqueued stuck deliveries');
  return rows.length;
}
