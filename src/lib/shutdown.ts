import type { Logger } from './logger.js';

/**
 * Registers SIGTERM/SIGINT handlers that run `fn` once, then exit. A watchdog forces exit if
 * cleanup exceeds `timeoutMs` (keep it below the orchestrator's kill grace period, e.g. Docker's
 * `stop_grace_period`).
 */
export function onShutdown(logger: Logger, timeoutMs: number, fn: () => Promise<void>): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received; draining');
    const watchdog = setTimeout(() => {
      logger.error({ timeoutMs }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, timeoutMs);
    watchdog.unref();
    fn()
      .then(() => {
        clearTimeout(watchdog);
        logger.info('shutdown complete');
        logger.flush?.();
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
}
