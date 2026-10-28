import type { DeliveryStatus, DeliveryTrigger, EventType } from '@prisma/client';
import type { AppDeps } from '../deps.js';
import { buildWebhookPayload } from '../domain/events.js';
import { decryptSecret } from '../lib/crypto.js';
import { conflict, isUniqueViolation, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { enqueueDelivery } from '../queues/queues.js';
import { postWebhook, type SendResult } from './http-sender.js';
import { backoffDelayMs, classifyAttempt } from './retry-policy.js';
import { HEADERS, signatureHeader } from './signing.js';

export type DeliveryDeps = Pick<AppDeps, 'prisma' | 'queues' | 'config' | 'logger' | 'metrics' | 'destinations'>;

export type ProcessDeliveryResult =
  | { status: 'SKIPPED'; reason: 'NOT_FOUND' | 'NOT_CLAIMABLE' | 'LOST_LOCK' }
  | { status: 'CANCELLED' }
  | { status: Extract<DeliveryStatus, 'SUCCEEDED' | 'RETRY_SCHEDULED' | 'FAILED'>; attemptNumber: number; nextAttemptAt?: Date };

interface ClaimedRow {
  id: string;
  attempt_count: number;
  max_attempts: number;
  subscription_id: string;
  event_id: string;
}

/**
 * Executes one delivery attempt. Any number of jobs may point at the same delivery (retries, sweeper
 * re-enqueues, manual redelivery); the atomic claim below guarantees only one of them sends at a time.
 *
 * Claim rules:
 *  - PENDING / RETRY_SCHEDULED and due → claim, attempt_count + 1;
 *  - IN_PROGRESS whose lock expired (worker died mid-attempt) → reclaim with the SAME attempt number,
 *    because the dead worker never committed an attempt record for it.
 */
export async function processDelivery(
  deps: DeliveryDeps,
  deliveryId: string,
  opts: { trigger: DeliveryTrigger },
): Promise<ProcessDeliveryResult> {
  const { webhooks } = deps.config;
  const log = deps.logger.child({ deliveryId });

  const claimed = await deps.prisma.$queryRaw<ClaimedRow[]>`
    UPDATE webhook_deliveries
       SET status = 'IN_PROGRESS',
           attempt_count = CASE WHEN status = 'IN_PROGRESS' THEN attempt_count ELSE attempt_count + 1 END,
           locked_until = now() + (${webhooks.lockSeconds} * interval '1 second'),
           last_attempt_at = now(),
           updated_at = now()
     WHERE id = ${deliveryId}
       AND (
             (status IN ('PENDING', 'RETRY_SCHEDULED') AND next_attempt_at <= now() + interval '2 seconds' AND attempt_count < max_attempts)
          OR (status = 'IN_PROGRESS' AND locked_until < now())
           )
    RETURNING id, attempt_count, max_attempts, subscription_id, event_id`;

  const row = claimed[0];
  if (!row) {
    const exists = await deps.prisma.webhookDelivery.count({ where: { id: deliveryId } });
    log.debug({ exists: exists > 0 }, 'delivery not claimable; skipping job');
    return { status: 'SKIPPED', reason: exists ? 'NOT_CLAIMABLE' : 'NOT_FOUND' };
  }
  const attemptNumber = row.attempt_count;

  const [subscription, event] = await Promise.all([
    deps.prisma.webhookSubscription.findUnique({ where: { id: row.subscription_id } }),
    deps.prisma.policyEvent.findUnique({ where: { id: row.event_id } }),
  ]);

  if (!subscription || subscription.status !== 'ACTIVE' || !event) {
    await deps.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'CANCELLED',
        lockedUntil: null,
        attemptCount: { decrement: 1 }, // the claim counted an attempt that never happened
        lastError: !event ? 'Event no longer exists' : 'Subscription is not active',
      },
    });
    deps.metrics.deliveriesFinalized.inc({ status: 'CANCELLED' });
    log.info({ subscriptionId: row.subscription_id }, 'delivery cancelled: subscription inactive');
    return { status: 'CANCELLED' };
  }

  const body = JSON.stringify(
    buildWebhookPayload({ ...event, eventType: event.eventType as EventType }),
  );
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = decryptSecret(subscription.secretCiphertext, deps.config.secretEncryptionKey);
  const startedAt = new Date();

  // Re-validate on every attempt: the policy (e.g. allowlist) may have changed since subscription time.
  const validation = deps.destinations.validateUrl(subscription.url);
  const send: SendResult = validation.ok
    ? await postWebhook({
        url: validation.url,
        body,
        timeoutMs: webhooks.timeoutMs,
        lookup: deps.destinations.guardedLookup,
        headers: {
          [HEADERS.signature]: signatureHeader(secret, timestamp, body),
          [HEADERS.timestamp]: String(timestamp),
          [HEADERS.eventId]: event.id,
          [HEADERS.eventType]: event.eventType,
          [HEADERS.deliveryId]: deliveryId,
          [HEADERS.attempt]: String(attemptNumber),
        },
      })
    : { kind: 'error', error: 'BLOCKED_DESTINATION', message: validation.reason, durationMs: 0 };

  const completedAt = new Date();
  const classification = classifyAttempt(send);
  let nextStatus: 'SUCCEEDED' | 'RETRY_SCHEDULED' | 'FAILED';
  let nextAttemptAt: Date | undefined;
  if (classification.outcome === 'SUCCESS') {
    nextStatus = 'SUCCEEDED';
  } else if (classification.retryable && attemptNumber < row.max_attempts) {
    nextStatus = 'RETRY_SCHEDULED';
    let delay = backoffDelayMs(attemptNumber, { baseMs: webhooks.backoffBaseMs, maxMs: webhooks.backoffMaxMs });
    if (classification.retryAfterSeconds !== undefined) {
      delay = Math.max(delay, Math.min(classification.retryAfterSeconds * 1000, webhooks.backoffMaxMs));
    }
    nextAttemptAt = new Date(completedAt.getTime() + delay);
  } else {
    nextStatus = 'FAILED';
  }

  const responseStatus = send.kind === 'response' ? send.status : null;
  const errorText = classification.outcome === 'SUCCESS' ? null : classification.message.slice(0, 500);
  const destinationHost = validation.ok ? validation.url.host : '(rejected)';

  try {
    await deps.prisma.$transaction(async (tx) => {
      await tx.deliveryAttempt.create({
        data: {
          id: newId('att'),
          deliveryId,
          attemptNumber,
          trigger: opts.trigger,
          outcome: classification.outcome,
          destinationHost,
          responseStatus,
          responseBodySnippet: send.kind === 'response' ? send.bodySnippet || null : null,
          errorMessage: errorText,
          signatureTimestamp: timestamp,
          durationMs: send.durationMs,
          startedAt,
          completedAt,
        },
      });
      // Guarded by status + attempt number so a worker whose lock expired cannot clobber newer state.
      const updated = await tx.webhookDelivery.updateMany({
        where: { id: deliveryId, status: 'IN_PROGRESS', attemptCount: attemptNumber },
        data: {
          status: nextStatus,
          lockedUntil: null,
          lastResponseStatus: responseStatus,
          lastError: errorText,
          ...(nextStatus === 'SUCCEEDED' ? { succeededAt: completedAt } : {}),
          ...(nextStatus === 'FAILED' ? { failedAt: completedAt } : {}),
          ...(nextAttemptAt ? { nextAttemptAt, enqueuedAt: completedAt } : {}),
        },
      });
      if (updated.count === 0) throw new LostLockError();
    });
  } catch (err) {
    if (err instanceof LostLockError || isUniqueViolation(err)) {
      log.warn({ attemptNumber }, 'delivery lock lost to another worker; discarding this attempt result');
      return { status: 'SKIPPED', reason: 'LOST_LOCK' };
    }
    throw err;
  }

  deps.metrics.deliveryAttempts.inc({ outcome: classification.outcome });
  deps.metrics.deliveryDuration.observe({ outcome: classification.outcome }, send.durationMs / 1000);
  const ctx = {
    eventId: event.id,
    eventType: event.eventType,
    subscriptionId: subscription.id,
    destinationHost,
    attemptNumber,
    maxAttempts: row.max_attempts,
    outcome: classification.outcome,
    responseStatus,
    durationMs: send.durationMs,
  };

  if (nextStatus === 'SUCCEEDED') {
    deps.metrics.deliveriesFinalized.inc({ status: 'SUCCEEDED' });
    log.info(ctx, 'webhook delivered');
  } else if (nextStatus === 'RETRY_SCHEDULED') {
    log.warn({ ...ctx, error: errorText, nextAttemptAt }, 'webhook attempt failed; retry scheduled');
    try {
      await enqueueDelivery(
        deps.queues,
        { deliveryId, trigger: 'AUTOMATIC', correlationId: event.correlationId ?? event.id },
        { jobId: `${deliveryId}-a${attemptNumber + 1}`, delayMs: nextAttemptAt!.getTime() - Date.now() },
      );
    } catch (err) {
      log.warn({ err }, 'retry enqueue failed; sweeper will recover');
    }
  } else {
    deps.metrics.deliveriesFinalized.inc({ status: 'FAILED' });
    log.error({ ...ctx, error: errorText, retryable: classification.outcome !== 'SUCCESS' && classification.retryable }, 'webhook delivery failed permanently');
  }

  return { status: nextStatus, attemptNumber, nextAttemptAt };
}

class LostLockError extends Error {}

/**
 * Manual redelivery (operator action). Re-sends the *same* event (same eventId, same body) with a
 * fresh attempt budget; receivers that deduplicate on eventId will treat it as a duplicate.
 */
export async function requestRedelivery(deps: DeliveryDeps, deliveryId: string, correlationId: string) {
  const delivery = await deps.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: DeliveryStatus; attempt_count: number; subscription_status: string }>>`
      SELECT d.status, d.attempt_count, s.status AS subscription_status
        FROM webhook_deliveries d
        JOIN webhook_subscriptions s ON s.id = d.subscription_id
       WHERE d.id = ${deliveryId}
         FOR UPDATE OF d`;
    const current = rows[0];
    if (!current) throw notFound('Delivery', deliveryId);
    if (current.status === 'PENDING' || current.status === 'IN_PROGRESS') {
      throw conflict('DELIVERY_IN_FLIGHT', 'Delivery is already queued or in progress');
    }
    if (current.subscription_status !== 'ACTIVE') {
      throw conflict('SUBSCRIPTION_INACTIVE', 'Reactivate the subscription before requesting redelivery');
    }
    const now = new Date();
    return tx.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'PENDING',
        nextAttemptAt: now,
        enqueuedAt: now,
        failedAt: null,
        maxAttempts: current.attempt_count + deps.config.webhooks.maxAttempts,
        manualRetryCount: { increment: 1 },
      },
    });
  });

  await enqueueDelivery(
    deps.queues,
    { deliveryId, trigger: 'MANUAL', correlationId },
    { jobId: `${deliveryId}-m${delivery.manualRetryCount}` },
  );
  deps.logger.info({ deliveryId, manualRetryCount: delivery.manualRetryCount }, 'manual redelivery requested');
  return delivery;
}
