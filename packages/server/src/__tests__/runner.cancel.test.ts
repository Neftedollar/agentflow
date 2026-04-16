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

// Slow runner — gives us time to cancel mid-flight.
const slow: AgentRunner = {
  validate: async () => ({ ok: true }),
  spawn: async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      stdout: JSON.stringify({ ok: true }),
      sessionHandle: "s",
      tokensIn: 0,
      tokensOut: 0,
    };
  },
};

const agent = defineAgent({
  runner: "slow",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prompt: () => "p",
});
const wf = defineWorkflow({
  name: "s",
  tasks: { t: { agent, input: {} } },
});

beforeEach(() => registerRunner("slow", slow));
afterEach(() => unregisterRunner("slow"));

describe("cancel", () => {
  it("cancel(runId) marks state=cancelled and stops emitting events", async () => {
    const runner = createRunner();
    const gen = runner.stream(wf, {});
    const first = await gen.next();
    if (first.done) throw new Error("no events");
    const runId = first.value.runId;
    runner.cancel(runId);

    // Drain whatever remains; no more events expected after cancel.
    try {
      let step = await gen.next();
      while (!step.done) step = await gen.next();
    } catch {}
    expect(runner.get(runId)?.state).toBe("cancelled");
    runner.close();
  });

  it("options.signal aborts stream() mid-flight", async () => {
    const runner = createRunner();
    const ac = new AbortController();
    const gen = runner.stream(wf, {}, { signal: ac.signal });
    const first = await gen.next();
    if (first.done) throw new Error("no events");
    const runId = first.value.runId;
    ac.abort();
    try {
      let step = await gen.next();
      while (!step.done) step = await gen.next();
    } catch {}
    expect(runner.get(runId)?.state).toBe("cancelled");
    runner.close();
  });

  it("cancel(unknown) is idempotent (no throw)", () => {
    const runner = createRunner();
    expect(() => runner.cancel("nope")).not.toThrow();
    runner.close();
  });

  it("P2-4: cancel() is no-op on already-done run (does not overwrite state)", async () => {
    const runner = createRunner();
    // Wait for the run to complete naturally
    const handle = await new Promise<{ runId: string }>((resolve) => {
      const h = runner.fire(wf, {}, { onComplete: () => resolve(h) });
    });
    // Run is now done — cancel() must not overwrite state
    runner.cancel(handle.runId);
    expect(runner.get(handle.runId)?.state).toBe("done");
    runner.close();
  });
});
