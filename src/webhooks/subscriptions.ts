import type { AppDeps } from '../deps.js';
import { encryptSecret, generateWebhookSecret } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

export const ALL_EVENTS = '*';

export function subscriptionMatches(
  sub: { eventTypes: string[]; carrierIds: string[] },
  event: { eventType: string; carrierId: string },
): boolean {
  const typeOk = sub.eventTypes.includes(ALL_EVENTS) || sub.eventTypes.includes(event.eventType);
  const carrierOk = sub.carrierIds.length === 0 || sub.carrierIds.includes(event.carrierId);
  return typeOk && carrierOk;
}

export async function assertDeliverableUrl(deps: Pick<AppDeps, 'destinations'>, url: string): Promise<void> {
  const result = await deps.destinations.validateResolvedUrl(url);
  if (!result.ok) {
    throw badRequest('INVALID_WEBHOOK_URL', `Webhook URL rejected: ${result.reason}`, [{ path: 'url', message: result.reason }]);
  }
}

export async function createSubscription(
  deps: Pick<AppDeps, 'prisma' | 'config' | 'destinations'>,
  input: { url: string; eventTypes: string[]; carrierIds: string[]; description?: string | null },
) {
  await assertDeliverableUrl(deps, input.url);
  const secret = generateWebhookSecret();
  const subscription = await deps.prisma.webhookSubscription.create({
    data: {
      id: newId('sub'),
      url: input.url,
      description: input.description ?? null,
      eventTypes: [...new Set(input.eventTypes)].sort(),
      carrierIds: [...new Set(input.carrierIds)].sort(),
      secretCiphertext: encryptSecret(secret, deps.config.secretEncryptionKey),
      secretHint: secret.slice(-4),
    },
  });
  // The plaintext secret is returned exactly once, here.
  return { subscription, secret };
}
