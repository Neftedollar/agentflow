import {
  defineAgent,
  defineWorkflow,
  registerRunner,
  unregisterRunner,
} from "@ageflow/core";
import type { Runner as AgentRunner } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRunner } from "../runner.js";
import type { PersistedRunRecord, RunStore } from "../types.js";

const stub: AgentRunner = {
  validate: async () => ({ ok: true }),
  spawn: async () => ({
    stdout: JSON.stringify({ ok: true }),
    sessionHandle: "replay",
    tokensIn: 0,
    tokensOut: 0,
  }),
};

const agent = defineAgent({
  runner: "replay-stub",
  input: z.object({ q: z.string() }),
  output: z.object({ ok: z.boolean() }),
  prompt: () => "p",
});

const workflow = defineWorkflow({
  name: "replay-workflow",
  tasks: { t: { agent, input: { q: "seed" } } },
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

beforeEach(() => registerRunner("replay-stub", stub));
afterEach(() => unregisterRunner("replay-stub"));

describe("runner recovery", () => {
  it("replays a stored running job under the same runId", async () => {
    const store = new RecordingRunStore();
    const runId = "replay-run";
    store.upsert({
      runId,
      workflowName: workflow.name,
      state: "running",
      createdAt: 1_700_000_000_000,
      lastEventAt: 1_700_000_000_000,
      input: { q: "seed" },
    });

    const runner = createRunner({ store });
    let spawnCalls = 0;
    const originalSpawn = stub.spawn;
    stub.spawn = async (...args) => {
      spawnCalls += 1;
      return originalSpawn(...args);
    };

    try {
      runner.recover?.(workflow);

      for (let i = 0; i < 50; i += 1) {
        if (store.get(runId)?.state === "done") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }

      expect(spawnCalls).toBeGreaterThan(0);
      expect(runner.get(runId)?.runId).toBe(runId);
      expect(runner.get(runId)?.state).toBe("done");
      expect(store.get(runId)?.state).toBe("done");
    } finally {
      stub.spawn = originalSpawn;
      await runner.close();
    }
  });
});
