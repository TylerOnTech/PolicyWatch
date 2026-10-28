import { CarrierError } from './types.js';

export interface CarrierHttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}

export interface CarrierHttpResponse {
  status: number;
  headers: Headers;
  body: string;
}

/**
 * Transport for carrier calls. Carrier base URLs come from operator configuration (not user input),
 * so no SSRF guard is applied here. Network failures and timeouts are classified; HTTP status codes
 * are returned to the adapter, which knows the carrier's own conventions.
 */
export async function carrierRequest(req: CarrierHttpRequest): Promise<CarrierHttpResponse> {
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body,
      signal,
      redirect: 'error',
    });
  } catch (err) {
    if (timeout.aborted) throw new CarrierError('CARRIER_TIMEOUT', `Carrier did not respond within ${req.timeoutMs}ms`);
    throw new CarrierError('CARRIER_UNAVAILABLE', `Carrier connection failed: ${describeNetworkError(err)}`);
  }

  try {
    const body = await readBodyLimited(res, req.maxResponseBytes);
    return { status: res.status, headers: res.headers, body };
  } catch (err) {
    if (err instanceof CarrierError) throw err;
    if (timeout.aborted) throw new CarrierError('CARRIER_TIMEOUT', `Carrier response body timed out after ${req.timeoutMs}ms`);
    throw new CarrierError('CARRIER_UNAVAILABLE', `Carrier response interrupted: ${describeNetworkError(err)}`);
  }
}

async function readBodyLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new CarrierError('INVALID_CARRIER_RESPONSE', `Carrier response exceeded ${limit} bytes`, res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function describeNetworkError(err: unknown): string {
  const cause = (err as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (err instanceof Error ? err.message : 'unknown error');
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(3600, Math.ceil((date - Date.now()) / 1000)));
  return undefined;
}

/** Shared mapping of non-2xx HTTP statuses. Adapters handle carrier-specific "200 with error" bodies. */
export function classifyHttpStatus(res: CarrierHttpResponse): CarrierError | null {
  const s = res.status;
  if (s >= 200 && s < 300) return null;
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  if (s === 404) return new CarrierError('POLICY_NOT_FOUND', 'Carrier reported the policy was not found', s);
  if (s === 401 || s === 403) return new CarrierError('CARRIER_AUTH_FAILED', `Carrier rejected credentials (HTTP ${s})`, s);
  if (s === 429) return new CarrierError('CARRIER_RATE_LIMITED', 'Carrier rate limit exceeded', s, retryAfter);
  if (s === 408 || s === 504) return new CarrierError('CARRIER_TIMEOUT', `Carrier gateway timeout (HTTP ${s})`, s);
  if (s >= 500) return new CarrierError('CARRIER_UNAVAILABLE', `Carrier error (HTTP ${s})`, s, retryAfter);
  return new CarrierError('CARRIER_REQUEST_REJECTED', `Carrier rejected the request (HTTP ${s})`, s);
}

export function parseJsonBody(res: CarrierHttpResponse): unknown {
  try {
    return JSON.parse(res.body);
  } catch {
    throw new CarrierError('INVALID_CARRIER_RESPONSE', 'Carrier returned a body that is not valid JSON', res.status);
  }
}
