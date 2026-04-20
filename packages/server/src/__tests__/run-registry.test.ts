import type { RunHandle } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunRegistry } from "../run-registry.js";
import type { PersistedRunRecord, RunStore } from "../types.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

class RecordingRunStore implements RunStore {
  readonly snapshots = new Map<string, PersistedRunRecord>();
  readonly deleted: string[] = [];

  constructor(initial: readonly PersistedRunRecord[] = []) {
    for (const snapshot of initial) {
      this.snapshots.set(snapshot.runId, structuredClone(snapshot));
    }
  }

  get(runId: string): PersistedRunRecord | undefined {
    const snapshot = this.snapshots.get(runId);
    return snapshot !== undefined ? structuredClone(snapshot) : undefined;
  }

  list(): readonly PersistedRunRecord[] {
    return [...this.snapshots.values()].map((snapshot) =>
      structuredClone(snapshot),
    );
  }

  upsert(snapshot: PersistedRunRecord): void {
    this.snapshots.set(snapshot.runId, structuredClone(snapshot));
  }

  delete(runId: string): void {
    this.deleted.push(runId);
    this.snapshots.delete(runId);
  }

  close(): void {}
}

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

  it("hydrates existing snapshots from the store", () => {
    const seededStore = new RecordingRunStore([
      {
        runId: "seed",
        workflowName: "wf",
        state: "done",
        createdAt: 100,
        lastEventAt: 200,
        input: { recovered: true },
        result: {
          outputs: { ok: true },
          metrics: {
            totalLatencyMs: 1,
            totalTokensIn: 2,
            totalTokensOut: 3,
            totalEstimatedCost: 0.1,
            taskCount: 1,
          },
        },
      },
    ]);
    const reg = new RunRegistry({
      ttlMs: 1000,
      checkpointTtlMs: 2000,
      reaperIntervalMs: 500,
      store: seededStore,
    });
    expect(reg.get("seed")).toMatchObject({
      runId: "seed",
      state: "done",
    });
    expect(reg.list()).toHaveLength(1);
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

  it("deletes expired terminal snapshots from the backing store", () => {
    const store = new RecordingRunStore([
      {
        runId: "r1",
        workflowName: "wf",
        state: "done",
        createdAt: 0,
        lastEventAt: 0,
        result: {
          outputs: {},
          metrics: {
            totalLatencyMs: 0,
            totalTokensIn: 0,
            totalTokensOut: 0,
            totalEstimatedCost: 0,
            taskCount: 0,
          },
        },
      },
    ]);
    const reg = new RunRegistry({
      ttlMs: 1000,
      checkpointTtlMs: 2000,
      reaperIntervalMs: 100,
      store,
    });
    vi.advanceTimersByTime(1500);
    expect(reg.get("r1")).toBeUndefined();
    expect(store.deleted).toContain("r1");
    reg.stop();
  });
});
