import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunRegistry } from "../run-registry.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RunRegistry", () => {
  it("stores, retrieves, lists", () => {
    const reg = new RunRegistry({
      ttlMs: 1000,
      checkpointTtlMs: 2000,
      reaperIntervalMs: 500,
    });
    const h = reg.create({ runId: "r1", workflowName: "wf" });
    expect(reg.get("r1")?.runId).toBe("r1");
    expect(reg.list().length).toBe(1);
    h.markDone({
      outputs: {},
      metrics: {
        totalLatencyMs: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalEstimatedCost: 0,
        taskCount: 0,
      },
    });
    expect(reg.get("r1")?.state).toBe("done");
    reg.stop();
  });

  it("reaper evicts terminal runs after ttlMs", () => {
    const reg = new RunRegistry({
      ttlMs: 1000,
      checkpointTtlMs: 10_000,
      reaperIntervalMs: 100,
    });
    const h = reg.create({ runId: "r1", workflowName: "wf" });
    h.markDone({
      outputs: {},
      metrics: {
        totalLatencyMs: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalEstimatedCost: 0,
        taskCount: 0,
      },
    });
    vi.advanceTimersByTime(1500);
    expect(reg.get("r1")).toBeUndefined();
    reg.stop();
  });

  it("reaper auto-rejects awaiting-checkpoint runs after checkpointTtlMs", () => {
    const reg = new RunRegistry({
      ttlMs: 60_000,
      checkpointTtlMs: 500,
      reaperIntervalMs: 100,
    });
    const h = reg.create({ runId: "r1", workflowName: "wf" });
    let rejected = false;
    h.markAwaitingCheckpoint(
      {
        type: "checkpoint",
        runId: "r1",
        workflowName: "wf",
        timestamp: Date.now(),
        taskName: "t",
        message: "m",
      },
      (approved) => {
        if (!approved) rejected = true;
      },
    );
    vi.advanceTimersByTime(700);
    expect(rejected).toBe(true);
    expect(reg.get("r1")?.state).toBe("failed");
    reg.stop();
  });
});
