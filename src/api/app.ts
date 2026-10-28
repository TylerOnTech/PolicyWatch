import type { QueueEvents } from 'bullmq';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { AppDeps } from '../deps.js';
import { currentCorrelationId } from '../lib/context.js';
import { createCheckQueueEvents } from '../queues/queues.js';
import {
  authenticate,
  errorHandler,
  httpMetrics,
  notFoundHandler,
  requestContext,
  requireScope,
  securityHeaders,
} from './middleware.js';
import { loadOpenApiSpec } from './openapi.js';
import { deliveriesRouter } from './routes/deliveries.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { policiesRouter } from './routes/policies.js';
import { subscriptionsRouter } from './routes/subscriptions.js';

export interface ApiApp {
  app: Express;
  close(): Promise<void>;
}

export function createApiApp(deps: AppDeps): ApiApp {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.api.trustProxy);
  app.set('query parser', 'simple');

  // QueueEvents holds a dedicated Redis subscription; create it only if a caller asks to wait on a job.
  let queueEvents: Promise<QueueEvents> | undefined;
  const getQueueEvents = () => {
    queueEvents ??= (async () => {
      const qe = createCheckQueueEvents(deps.queues.connection, deps.queues.prefix);
      await qe.waitUntilReady();
      return qe;
    })();
    return queueEvents;
  };

  app.use(requestContext);
  app.use(securityHeaders());
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => (res.getHeader('x-request-id') as string) ?? currentCorrelationId() ?? 'unknown',
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => req.url === '/health/live' },
      serializers: {
        // Log the route shape, never headers (Authorization) or bodies (PII).
        req: (req: { method: string; url: string; id: unknown }) => ({ method: req.method, url: req.url.split('?')[0], id: req.id }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(httpMetrics(deps.metrics));
  app.use(express.json({ limit: '64kb' }));

  // Public
  app.use(healthRouter(deps));
  const spec = loadOpenApiSpec();
  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'PolicyWatch API' }));

  // Authenticated
  const api = express.Router();
  api.use(authenticate(deps.config));
  api.get('/metrics', requireScope('read'), async (_req, res) => {
    res.type(deps.metrics.registry.contentType).send(await deps.metrics.registry.metrics());
  });
  api.use(policiesRouter(deps, getQueueEvents));
  api.use(eventsRouter(deps));
  api.use(subscriptionsRouter(deps));
  api.use(deliveriesRouter(deps));
  app.use(api);

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));

  return {
    app,
    async close() {
      if (queueEvents) await (await queueEvents).close();
    },
  };
}
