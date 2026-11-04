import { logger } from '../../platform/logging/logger.js';

/**
 * Small interval loop with cooperative shutdown: `stop()` wakes the sleep,
 * waits for the in-flight tick (bounded by a grace period) and prevents new
 * ticks. Used by the outbox publisher and the PENDING_REFERENCE worker.
 */
export class PeriodicWorker {
  private running = false;
  private loopPromise?: Promise<void>;
  private wakeUp?: () => void;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(graceMs: number): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    if (this.loopPromise === undefined) {
      return;
    }
    await Promise.race([
      this.loopPromise,
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        logger.error({ err: error, worker: this.name }, 'worker tick failed');
      }
      if (!this.running) {
        break;
      }
      await this.sleep(this.intervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = undefined;
        resolve();
      }, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
    });
  }
}
