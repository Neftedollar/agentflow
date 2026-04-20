import {
  defineAgent,
  defineWorkflow,
  registerRunner,
  unregisterRunner,
} from "@ageflow/core";
import type { Runner as AgentRunner, RunHandle } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRunner } from "../runner.js";
import type { PersistedRunRecord, RunStore } from "../types.js";

const stub: AgentRunner = {
  validate: async () => ({ ok: true }),
  spawn: async () => ({
    stdout: JSON.stringify({ ok: true }),
    sessionHandle: "s",
    tokensIn: 0,
    tokensOut: 0,
  }),
};
const agent = defineAgent({
  runner: "stub",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prompt: () => "p",
  hitl: { mode: "checkpoint", message: "please approve" },
});
const wf = defineWorkflow({
  name: "gated",
  tasks: { t: { agent, input: {} } },
});

class RecordingRunStore implements RunStore {
  readonly snapshots = new Map<string, PersistedRunRecord>();

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
    this.snapshots.delete(runId);
  }

  close(): void {}
}

beforeEach(() => registerRunner("stub", stub));
afterEach(() => unregisterRunner("stub"));

describe("async HITL", () => {
  it("pauses, exposes pendingCheckpoint, resumes on approve=true", async () => {
    const runner = createRunner();
    const events = [];
    const gen = runner.stream(wf, {});

    let runId: string | undefined;
    let step = await gen.next();
    while (!step.done && step.value.type !== "checkpoint") {
      events.push(step.value);
      runId = step.value.runId;
      step = await gen.next();
    }
    expect(step.done).toBe(false);
    if (!step.done) {
      runId = step.value.runId;
      events.push(step.value);
    }

    // Handle is in awaiting-checkpoint
    // biome-ignore lint/style/noNonNullAssertion: runId is set before this point
    expect(runner.get(runId!)?.state).toBe("awaiting-checkpoint");
    // biome-ignore lint/style/noNonNullAssertion: runId is set before this point
    expect(runner.get(runId!)?.pendingCheckpoint).toBeDefined();

    // Resume from another "request"
    // biome-ignore lint/style/noNonNullAssertion: runId is set before this point
    runner.resume(runId!, true);

    // Drain rest
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    expect(events.at(-1)?.type).toBe("workflow:complete");
    await runner.close();
  });

  it("resume(false) fails with workflow:error", async () => {
    const runner = createRunner();
    const events = [];
    const gen = runner.stream(wf, {});
    let step = await gen.next();
    let runId: string | undefined;
    while (!step.done) {
      events.push(step.value);
      runId = step.value.runId;
      if (step.value.type === "checkpoint") break;
      step = await gen.next();
    }
    // biome-ignore lint/style/noNonNullAssertion: runId is set before this point
    runner.resume(runId!, false);
    try {
      let next = await gen.next();
      while (!next.done) {
        events.push(next.value);
        next = await gen.next();
      }
    } catch {
      // driver throws — acceptable
    }
    expect(events.at(-1)?.type).toBe("workflow:error");
    await runner.close();
  });

  it("auto-rejects after checkpointTtlMs", async () => {
    vi.useFakeTimers();
    const runner = createRunner({ checkpointTtlMs: 50, reaperIntervalMs: 10 });
    const events = [];
    const gen = runner.stream(wf, {});
    let step = await gen.next();
    while (!step.done && step.value.type !== "checkpoint") {
      events.push(step.value);
      step = await gen.next();
    }
    if (!step.done) events.push(step.value);
    await vi.advanceTimersByTimeAsync(200);
    // Driver should have rejected; drain remaining
    try {
      let next = await gen.next();
      while (!next.done) {
        events.push(next.value);
        next = await gen.next();
      }
    } catch {}
    expect(events.at(-1)?.type).toBe("workflow:error");
    await runner.close();
    vi.useRealTimers();
  });

  it("resume() on unknown runId throws RunNotFoundError", async () => {
    const runner = createRunner();
    expect(() => runner.resume("does-not-exist", true)).toThrow(/not found/i);
    await runner.close();
  });

  it("resume() on running run throws InvalidRunStateError", async () => {
    const runner = createRunner();
    const plain = defineAgent({
      runner: "stub",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "p",
    });
    const wfp = defineWorkflow({
      name: "p",
      tasks: { t: { agent: plain, input: {} } },
    });
    await runner.run(wfp, {});
    const id = runner.list()[0]?.runId;
    if (id) expect(() => runner.resume(id, true)).toThrow();
    await runner.close();
  });

  it("persists awaiting-checkpoint snapshots to the store", async () => {
    const store = new RecordingRunStore();
    const runner = createRunner({ store });
    const gen = runner.stream(wf, {});
    let step = await gen.next();
    while (!step.done && step.value.type !== "checkpoint") {
      step = await gen.next();
    }
    expect(step.done).toBe(false);
    const snapshot = [...store.snapshots.values()][0];
    expect(snapshot?.state).toBe("awaiting-checkpoint");
    expect(snapshot?.pendingCheckpoint?.taskName).toBe("t");
    if (!step.done) {
      runner.resume(step.value.runId, true);
    }
    let next = await gen.next();
    while (!next.done) {
      next = await gen.next();
    }
    await runner.close();
  });
});
