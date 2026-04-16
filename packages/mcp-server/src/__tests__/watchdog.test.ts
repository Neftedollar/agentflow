import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurationWatchdog } from "../watchdog.js";

describe("DurationWatchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires abort after maxDurationSec elapsed", () => {
    const onTimeout = vi.fn();
    const wd = new DurationWatchdog(2, onTimeout);
    wd.start();
    vi.advanceTimersByTime(1999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("cancel() prevents firing", () => {
    const onTimeout = vi.fn();
    const wd = new DurationWatchdog(2, onTimeout);
    wd.start();
    wd.cancel();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("no-op when maxDurationSec is null (unlimited)", () => {
    const onTimeout = vi.fn();
    const wd = new DurationWatchdog(null, onTimeout);
    wd.start();
    vi.advanceTimersByTime(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("abortSignal fires when timer elapses", () => {
    const wd = new DurationWatchdog(1, () => {});
    wd.start();
    let aborted = false;
    wd.abortSignal.addEventListener("abort", () => {
      aborted = true;
    });
    vi.advanceTimersByTime(1100);
    expect(aborted).toBe(true);
  });
});
