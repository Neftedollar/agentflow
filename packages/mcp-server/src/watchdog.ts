/**
 * Fires a side-effect callback after `maxDurationSec` elapses and aborts via AbortController.
 *
 * - null maxDurationSec = no watchdog (unlimited).
 * - cancel() stops the timer and releases resources (used on successful completion).
 * - The `onTimeout` callback must NOT throw — it is called inside a setTimeout callback
 *   and any exception would become an uncaughtException rather than a promise rejection.
 *   Consumers should race their main promise against a rejection registered on
 *   `abortSignal`'s "abort" event to propagate the timeout as a proper rejection.
 */
export class DurationWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly controller = new AbortController();

  constructor(
    private readonly maxDurationSec: number | null,
    private readonly onTimeout: () => void,
  ) {}

  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.maxDurationSec === null) return;
    this.timer = setTimeout(() => {
      this.controller.abort();
      this.onTimeout();
    }, this.maxDurationSec * 1000);
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
