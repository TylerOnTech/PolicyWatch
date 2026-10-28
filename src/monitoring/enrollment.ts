import type { Policy } from '@prisma/client';
import type { AppDeps } from '../deps.js';
import { isUniqueViolation } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { enqueueCheck } from '../queues/queues.js';

export interface EnrollmentInput {
  carrierId: string;
  externalPolicyId: string;
  checkIntervalSeconds?: number;
  monitoringEnabled?: boolean;
}

/**
 * Enroll a carrier policy for monitoring and queue its baseline retrieval. Idempotent on
 * (carrierId, externalPolicyId): a repeat enrollment returns the existing record with created=false.
 */
export async function enrollPolicy(
  deps: Pick<AppDeps, 'prisma' | 'queues' | 'config' | 'clock' | 'logger'>,
  input: EnrollmentInput,
  correlationId: string,
): Promise<{ policy: Policy; created: boolean }> {
  const externalPolicyId = input.externalPolicyId.trim().toUpperCase();
  const now = deps.clock();
  let policy: Policy;
  try {
    policy = await deps.prisma.policy.create({
      data: {
        id: newId('pol'),
        carrierId: input.carrierId,
        externalPolicyId,
        checkIntervalSeconds: input.checkIntervalSeconds ?? deps.config.monitoring.defaultCheckIntervalSeconds,
        monitoringEnabled: input.monitoringEnabled ?? true,
        // The baseline check is queued directly below. If that enqueue is lost, the scheduler picks the
        // policy up once this lease expires.
        nextCheckAt: new Date(now.getTime() + deps.config.monitoring.schedulerLeaseSeconds * 1000),
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await deps.prisma.policy.findUniqueOrThrow({
      where: { carrierId_externalPolicyId: { carrierId: input.carrierId, externalPolicyId } },
    });
    return { policy: existing, created: false };
  }

  try {
    await enqueueCheck(deps.queues, { policyId: policy.id, trigger: 'ENROLLMENT', correlationId });
  } catch (err) {
    deps.logger.warn({ err, policyId: policy.id }, 'baseline check enqueue failed; scheduler will retry after lease');
  }
  return { policy, created: true };
}
