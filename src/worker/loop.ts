import type { Logger } from '../lib/logger.js';
import type { Metrics } from '../lib/metrics.js';

export interface LoopStatus {
  name: string;
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
}

/**
 * A non-overlapping periodic task. The next run starts `intervalMs` after the previous one finished
 * (never concurrently with itself). `poke()` wakes it early; returning `true` from the task means
 * "more work is waiting" and re-runs it immediately. Errors are logged and counted, never thrown,
 * with exponential backoff (capped at 30 s) while they persist.
 */
export class BackgroundLoop {
  private stopped = true;
  private wake: (() => void) | null = null;
  private current: Promise<void> | null = null;
  private lastRunAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<unknown>,
    private readonly deps: { logger: Logger; metrics: Metrics },
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.current = this.run();
  }

  poke(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.current;
  }

  status(): LoopStatus {
    return {
      name: this.name,
      running: !this.stopped,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let again = false;
      this.lastRunAt = new Date();
      try {
        again = (await this.task()) === true;
        this.lastSuccessAt = new Date();
        this.lastError = null;
        this.consecutiveErrors = 0;
      } catch (err) {
        this.consecutiveErrors += 1;
        this.lastError = err instanceof Error ? err.message : String(err);
        this.deps.metrics.loopErrors.inc({ loop: this.name });
        this.deps.logger.error({ err, loop: this.name, consecutiveErrors: this.consecutiveErrors }, 'background loop iteration failed');
      }
      if (this.stopped) break;
      if (again) continue;
      const delay =
        this.consecutiveErrors > 0
          ? Math.min(30_000, this.intervalMs * 2 ** Math.min(this.consecutiveErrors, 6))
          : this.intervalMs;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }
}
