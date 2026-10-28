import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { resolveCorrelationId, runWithContext } from '../lib/context.js';
import { safeEqual } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { Metrics } from '../lib/metrics.js';

export type Scope = 'read' | 'admin';

export interface AuthContext {
  scope: Scope;
  keyName: 'admin' | 'readonly';
}

/** Correlation ID: honor a well-formed inbound X-Request-Id, otherwise mint one; echo it back. */
export const requestContext: RequestHandler = (req, res, next) => {
  const correlationId = resolveCorrelationId(req.header('x-request-id') ?? req.header('x-correlation-id'));
  res.locals.correlationId = correlationId;
  res.setHeader('X-Request-Id', correlationId);
  runWithContext({ correlationId }, () => next());
};

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

/**
 * Bearer API-key authentication. Two keys are supported: an admin key (all operations) and an
 * optional read-only key (GET only). Comparison is constant-time on SHA-256 digests.
 */
export function authenticate(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="policywatch"');
      return next(new ApiError(401, 'UNAUTHENTICATED', 'Missing bearer API key'));
    }
    const presented = match[1]!;
    let auth: AuthContext | null = null;
    if (safeEqual(presented, config.auth.adminApiKey)) auth = { scope: 'admin', keyName: 'admin' };
    else if (config.auth.readonlyApiKey && safeEqual(presented, config.auth.readonlyApiKey)) {
      auth = { scope: 'read', keyName: 'readonly' };
    }
    if (!auth) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="policywatch", error="invalid_token"');
      return next(new ApiError(401, 'UNAUTHENTICATED', 'Invalid API key'));
    }
    res.locals.auth = auth;
    next();
  };
}

export function requireScope(scope: Scope): RequestHandler {
  return (_req, res, next) => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (!auth) return next(new ApiError(401, 'UNAUTHENTICATED', 'Missing bearer API key'));
    if (scope === 'admin' && auth.scope !== 'admin') {
      return next(new ApiError(403, 'FORBIDDEN', 'This operation requires the admin API key'));
    }
    next();
  };
}

export function httpMetrics(metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const end = metrics.httpDuration.startTimer({ method: req.method });
    res.on('finish', () => {
      // Use the route template (not the raw URL) to keep label cardinality bounded.
      const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
      end({ route });
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.correlationId as string | undefined;
    let status = 500;
    let body: { code: string; message: string; details?: unknown } = {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    };

    if (err instanceof ApiError) {
      status = err.status;
      body = { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) };
    } else if (err instanceof z.ZodError) {
      status = 400;
      body = {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (isBodyParserError(err)) {
      status = err.status ?? 400;
      body =
        err.type === 'entity.too.large'
          ? { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' }
          : err.type === 'entity.parse.failed'
            ? { code: 'INVALID_JSON', message: 'Request body is not valid JSON' }
            : { code: 'BAD_REQUEST', message: 'Request body could not be read' };
    }

    if (status >= 500) logger.error({ err, method: req.method, path: req.path }, 'unhandled API error');
    res.status(status).json({ error: { ...body, requestId } });
  };
}

function isBodyParserError(err: unknown): err is { type: string; status?: number } {
  return typeof err === 'object' && err !== null && typeof (err as { type?: unknown }).type === 'string' && 'status' in err;
}
