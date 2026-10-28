import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accept an inbound correlation ID only if it is well-formed; otherwise mint a new one. */
export function resolveCorrelationId(candidate: unknown): string {
  if (typeof candidate === 'string' && SAFE_CORRELATION_ID.test(candidate)) return candidate;
  return randomUUID();
}
