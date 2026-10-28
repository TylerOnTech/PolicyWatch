import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../deps.js';
import { scheduledCheckJobId } from '../queues/queues.js';

/**
 * Moves due policies onto the check queue. Safe to run on many workers at once:
 *  - `FOR UPDATE SKIP LOCKED` hands each due row to exactly one scheduler;
 *  - `next_check_at` is pushed out by a lease inside the same transaction, so the row is not
 *    re-selected while its job waits in the queue (the check sets the real next time when it runs);
 *  - the per-policy job ID makes a duplicate enqueue a no-op even if a lease expires early.
 *
 * Returns the number of policies enqueued.
 */
export async function scheduleDueChecks(deps: Pick<AppDeps, 'prisma' | 'queues' | 'config'>): Promise<number> {
  const { schedulerBatchSize, schedulerLeaseSeconds } = deps.config.monitoring;

  const ids = await deps.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM policies
       WHERE monitoring_enabled = true AND next_check_at <= now()
       ORDER BY next_check_at
       LIMIT ${schedulerBatchSize}
       FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await tx.$executeRaw`
      UPDATE policies
         SET next_check_at = now() + (${schedulerLeaseSeconds} * interval '1 second'), updated_at = now()
       WHERE id = ANY(${ids})`;
    return ids;
  });

  if (ids.length > 0) {
    await deps.queues.checks.addBulk(
      ids.map((policyId) => ({
        name: 'check',
        data: { policyId, trigger: 'SCHEDULED' as const, correlationId: randomUUID() },
        opts: { jobId: scheduledCheckJobId(policyId), removeOnComplete: true, removeOnFail: true },
      })),
    );
  }
  return ids.length;
}
