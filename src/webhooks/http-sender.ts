import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { BlockedDestinationError } from './ssrf.js';

export type SendResult =
  | { kind: 'response'; status: number; bodySnippet: string; retryAfterSeconds?: number; durationMs: number }
  | { kind: 'error'; error: 'TIMEOUT' | 'NETWORK_ERROR' | 'BLOCKED_DESTINATION'; message: string; durationMs: number };

export interface SendOptions {
  url: URL;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  lookup: LookupFunction;
  maxResponseBytes?: number;
}

const USER_AGENT = 'PolicyWatch-Webhooks/1.0 (+https://github.com/policywatch)';

/**
 * Minimal POST client for webhook delivery. Uses node:http directly so that DNS resolution goes
 * through the SSRF-guarded `lookup`, the total deadline covers connect + response, at most
 * `maxResponseBytes` of the response is buffered, and redirects are never followed.
 */
export function postWebhook(opts: SendOptions): Promise<SendResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const maxBytes = opts.maxResponseBytes ?? 2048;
  const transport = opts.url.protocol === 'https:' ? https : http;

  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const finish = (result: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const req = transport.request(
      opts.url,
      {
        method: 'POST',
        lookup: opts.lookup,
        agent: false, // no connection reuse across destinations; each attempt resolves afresh
        headers: {
          ...opts.headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(opts.body).toString(),
          'user-agent': USER_AGENT,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size < maxBytes) chunks.push(chunk.subarray(0, maxBytes - size));
          size += chunk.length;
          if (size >= maxBytes) res.destroy();
        });
        const complete = () =>
          finish({
            kind: 'response',
            status: res.statusCode ?? 0,
            bodySnippet: Buffer.concat(chunks).toString('utf8').slice(0, 512),
            retryAfterSeconds: parseRetryAfterHeader(res.headers['retry-after']),
            durationMs: elapsed(),
          });
        res.on('end', complete);
        res.on('close', complete);
        res.on('error', complete);
      },
    );

    const deadline = setTimeout(() => {
      req.destroy();
      finish({ kind: 'error', error: 'TIMEOUT', message: `No response within ${opts.timeoutMs}ms`, durationMs: elapsed() });
    }, opts.timeoutMs);

    req.on('error', (err) => {
      if (err instanceof BlockedDestinationError || (err as { code?: string }).code === 'ERR_BLOCKED_DESTINATION') {
        finish({ kind: 'error', error: 'BLOCKED_DESTINATION', message: err.message, durationMs: elapsed() });
        return;
      }
      const code = (err as { code?: string }).code;
      finish({ kind: 'error', error: 'NETWORK_ERROR', message: code ? `${code}: ${err.message}` : err.message, durationMs: elapsed() });
    });

    req.end(opts.body);
  });
}

function parseRetryAfterHeader(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
