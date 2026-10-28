import { createLogger } from '../lib/logger.js';
import { onShutdown } from '../lib/shutdown.js';
import { createMockReceiverApp } from '../simulators/mock-receiver/app.js';

const env = process.env;
const port = Number(env.RECEIVER_PORT ?? 4100);
const logger = createLogger({ level: env.LOG_LEVEL ?? 'info', service: 'mock-webhook-receiver' });
const secrets = (env.RECEIVER_SECRETS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const { app } = createMockReceiverApp({ secrets });
const server = app.listen(port, () => logger.info({ port, secretsConfigured: secrets.length }, 'mock webhook receiver listening'));
onShutdown(logger, 5_000, async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
