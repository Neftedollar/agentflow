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
  runner: "stub",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prompt: () => "p",
});
const wf = defineWorkflow({ name: "x", tasks: { t: { agent, input: {} } } });

beforeEach(() => registerRunner("stub", stub));
afterEach(() => unregisterRunner("stub"));

describe("createRunner().run", () => {
  it("returns the same WorkflowResult as draining stream()", async () => {
    const runner = createRunner();
    const r = await runner.run(wf, {});
    expect(r.outputs.t).toEqual({ ok: true });
    runner.close();
  });

  it("auto-rejects checkpoints when onCheckpoint is omitted", async () => {
    const a = defineAgent({
      runner: "stub",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "p",
      hitl: { mode: "checkpoint" },
    });
    const gated = defineWorkflow({
      name: "g",
      tasks: { t: { agent: a, input: {} } },
    });
    const runner = createRunner();
    await expect(runner.run(gated, {})).rejects.toThrow();
    runner.close();
  });
});
