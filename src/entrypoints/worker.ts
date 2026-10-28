import { ConfigError, loadConfig } from '../config.js';
import { closeDeps, createDeps } from '../deps.js';
import { onShutdown } from '../lib/shutdown.js';
import { startWorker } from '../worker/worker.js';

async function main() {
  const config = loadConfig();
  const deps = createDeps(config, { service: 'policywatch-worker', defaultMetrics: true });
  const worker = await startWorker(deps, { healthPort: config.worker.healthPort });

  onShutdown(deps.logger, config.shutdownTimeoutMs, async () => {
    await worker.stop();
    await closeDeps(deps);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
