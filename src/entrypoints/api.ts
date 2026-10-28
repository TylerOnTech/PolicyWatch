import { createApiApp } from '../api/app.js';
import { ConfigError, loadConfig } from '../config.js';
import { closeDeps, createDeps } from '../deps.js';
import { onShutdown } from '../lib/shutdown.js';

function main() {
  const config = loadConfig();
  const deps = createDeps(config, { service: 'policywatch-api', defaultMetrics: true });
  const api = createApiApp(deps);

  const server = api.app.listen(config.api.port, () => {
    deps.logger.info({ port: config.api.port, env: config.env }, 'API listening');
  });
  // Outlive typical proxy/ALB idle timeouts so the proxy closes idle connections first.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 60_000;

  onShutdown(deps.logger, config.shutdownTimeoutMs, async () => {
    // Stop accepting connections, let in-flight requests finish, then release dependencies.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    await closed;
    await api.close();
    await closeDeps(deps);
  });
}

try {
  main();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
