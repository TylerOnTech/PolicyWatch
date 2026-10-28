import { createLogger } from '../lib/logger.js';
import { onShutdown } from '../lib/shutdown.js';
import { createCarrierSimApp } from '../simulators/carrier-sim/app.js';

// The simulator reads the same CARRIER_* credential variables as the application, so both sides
// agree on the synthetic credentials without extra configuration.
const env = process.env;
const port = Number(env.SIM_PORT ?? 4000);
const logger = createLogger({ level: env.LOG_LEVEL ?? 'info', service: 'carrier-simulator' });

const { app } = createCarrierSimApp({
  acmeApiKey: env.CARRIER_ACME_API_KEY ?? 'sim-acme-api-key',
  bluebirdToken: env.CARRIER_BLUEBIRD_TOKEN ?? 'sim-bluebird-token',
  cardinalUsername: env.CARRIER_CARDINAL_USERNAME ?? 'policywatch',
  cardinalPassword: env.CARRIER_CARDINAL_PASSWORD ?? 'sim-cardinal-password',
  timeoutDelayMs: Number(env.SIM_TIMEOUT_DELAY_MS ?? 30_000),
});

const server = app.listen(port, () => logger.info({ port }, 'carrier simulator listening (synthetic data only)'));
onShutdown(logger, 5_000, async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
