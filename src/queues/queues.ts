import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_NAMES = {
  checks: 'policy-checks',
  deliveries: 'webhook-deliveries',
} as const;

export type CheckTriggerName = 'ENROLLMENT' | 'SCHEDULED' | 'MANUAL';
export type DeliveryTriggerName = 'AUTOMATIC' | 'MANUAL';

export interface PolicyCheckJobData {
  policyId: string;
  trigger: CheckTriggerName;
  correlationId: string;
}

export interface DeliveryJobData {
  deliveryId: string;
  trigger: DeliveryTriggerName;
  correlationId: string;
}

export interface Queues {
  checks: Queue<PolicyCheckJobData>;
  deliveries: Queue<DeliveryJobData>;
  prefix: string;
  connection: Redis;
}

/** BullMQ requires `maxRetriesPerRequest: null` for connections used by workers (blocking commands). */
export function createRedis(url: string, opts: { lazyConnect?: boolean } = {}): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: opts.lazyConnect });
}

// Job retries here only cover *internal* failures (e.g. database unavailable). Carrier failures and
// webhook HTTP failures are domain outcomes that are recorded and rescheduled explicitly.
const CHECK_JOB_DEFAULTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 86_400 },
};

const DELIVERY_JOB_DEFAULTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 5_000 },
  removeOnFail: { age: 7 * 86_400 },
};

export function createQueues(connection: Redis, prefix: string): Queues {
  return {
    checks: new Queue<PolicyCheckJobData>(QUEUE_NAMES.checks, { connection, prefix, defaultJobOptions: CHECK_JOB_DEFAULTS }),
    deliveries: new Queue<DeliveryJobData>(QUEUE_NAMES.deliveries, {
      connection,
      prefix,
      defaultJobOptions: DELIVERY_JOB_DEFAULTS,
    }),
    prefix,
    connection,
  };
}

export function createCheckQueueEvents(connection: Redis, prefix: string): QueueEvents {
  return new QueueEvents(QUEUE_NAMES.checks, { connection: connection.duplicate(), prefix });
}

// BullMQ custom job IDs may not contain ':' (it is the Redis key separator).

/** Scheduled checks share one job ID per policy, so a policy can never be queued twice concurrently. */
export const scheduledCheckJobId = (policyId: string) => `scheduled-${policyId}`;

export function enqueueCheck(queues: Queues, data: PolicyCheckJobData, opts: { jobId?: string; delayMs?: number } = {}) {
  const dedupe = data.trigger === 'SCHEDULED';
  return queues.checks.add('check', data, {
    jobId: opts.jobId ?? (dedupe ? scheduledCheckJobId(data.policyId) : undefined),
    delay: opts.delayMs,
    // A deduplicated ID must be released as soon as the job finishes, or the next schedule is ignored.
    ...(dedupe ? { removeOnComplete: true, removeOnFail: true } : {}),
  });
}

export function enqueueDelivery(queues: Queues, data: DeliveryJobData, opts: { jobId: string; delayMs?: number }) {
  return queues.deliveries.add('deliver', data, { jobId: opts.jobId, delay: opts.delayMs });
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.allSettled([queues.checks.close(), queues.deliveries.close()]);
}
