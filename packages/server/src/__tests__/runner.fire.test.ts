import {
  defineAgent,
  defineWorkflow,
  registerRunner,
  unregisterRunner,
} from "@ageflow/core";
import type { Runner as AgentRunner, RunHandle } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRunner } from "../runner.js";
import type { PersistedRunRecord, RunStore } from "../types.js";

const stub: AgentRunner = {
  validate: async () => ({ ok: true }),
  spawn: async () => ({
    stdout: JSON.stringify({ ok: true }),
    sessionHandle: "s",
    tokensIn: 1,
    tokensOut: 1,
  }),
};
const agent = defineAgent({
  runner: "stub2",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prompt: () => "p",
});
const wf = defineWorkflow({
  name: "fire-wf",
  tasks: { t: { agent, input: {} } },
});

class RecordingRunStore implements RunStore {
  readonly snapshots = new Map<string, PersistedRunRecord>();
  readonly upserts: PersistedRunRecord[] = [];

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
    this.upserts.push(structuredClone(snapshot));
    this.snapshots.set(snapshot.runId, structuredClone(snapshot));
  }

  delete(runId: string): void {
    this.snapshots.delete(runId);
  }

  close(): void {}
}

beforeEach(() => registerRunner("stub2", stub));
afterEach(() => unregisterRunner("stub2"));

describe("fire()", () => {
  it("invokes onEvent for each event and onComplete at the end", async () => {
    const runner = createRunner();
    const events: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      runner.fire(
        wf,
        {},
        {
          onEvent: (ev) => events.push(ev),
          onComplete: () => resolve(),
        },
      );
    });
    await done;
    expect(
      events.some((e) => (e as { type: string }).type === "workflow:complete"),
    ).toBe(true);
    await runner.close();
  });

  it("invokes onError when the workflow fails", async () => {
    const boomRunner: AgentRunner = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        throw new Error("boom");
      },
    };
    registerRunner("boom2", boomRunner);
    try {
      const a = defineAgent({
        runner: "boom2",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        prompt: () => "p",
        retry: { max: 1, on: ["subprocess_error"], backoff: "fixed" },
      });
      const wfb = defineWorkflow({
        name: "b",
        tasks: { t: { agent: a, input: {} } },
      });
      const runner = createRunner();
      const err = await new Promise<Error>((resolve) => {
        runner.fire(wfb, {}, { onError: resolve });
      });
      expect(err.message).toMatch(/boom/);
      await runner.close();
    } finally {
      unregisterRunner("boom2");
    }
  });

  it("P2-3: run reaches done state even when onEvent throws", async () => {
    const runner = createRunner();
    // onEvent throws on every call — must not prevent run from completing
    const done = new Promise<void>((resolve) => {
      runner.fire(
        wf,
        {},
        {
          onEvent: () => {
            throw new Error("onEvent kaboom");
          },
          onComplete: () => resolve(),
        },
      );
    });
    await done;
    await runner.close();
  });

  it("returns a RunHandle synchronously with state=running", async () => {
    const runner = createRunner();
    const handle = runner.fire(wf, {});
    expect(handle.runId).toBeDefined();
    expect(handle.state).toBe("running");
    expect(handle.workflowName).toBe("fire-wf");
    await runner.close();
  });

  it("persists the terminal snapshot to the configured store", async () => {
    const store = new RecordingRunStore();
    const runner = createRunner({ store });
    await runner.run(wf, {});
    const snapshot = [...store.snapshots.values()][0];
    expect(snapshot?.state).toBe("done");
    expect(snapshot?.result).toBeDefined();
    await runner.close();
  });
});
