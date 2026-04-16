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

describe("createRunner().stream", () => {
  it("streams events and returns WorkflowResult", async () => {
    const runner = createRunner();
    const events = [];
    const gen = runner.stream(wf, {});
    let r: IteratorResult<unknown, unknown>;
    do {
      r = await gen.next();
      if (!r.done) events.push(r.value);
    } while (!r.done);
    expect(events[0]).toMatchObject({ type: "workflow:start" });
    expect(events[events.length - 1]).toMatchObject({
      type: "workflow:complete",
    });
    runner.close();
  });

  it("registers the run and evicts on terminal + TTL", async () => {
    const runner = createRunner({ ttlMs: 10, reaperIntervalMs: 5 });
    for await (const _ of runner.stream(wf, {})) {
      // drain
    }
    expect(runner.list().length).toBeLessThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runner.list().length).toBe(0);
    runner.close();
  });
});
