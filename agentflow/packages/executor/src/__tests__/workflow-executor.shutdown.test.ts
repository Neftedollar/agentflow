import {
  defineAgent,
  defineWorkflow,
  registerRunner,
  unregisterRunner,
} from "@ageflow/core";
import type { Runner, RunnerSpawnResult } from "@ageflow/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../workflow-executor.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSpawnResult(data: unknown): RunnerSpawnResult {
  return {
    stdout: JSON.stringify(data),
    sessionHandle: "sess-shutdown",
    tokensIn: 1,
    tokensOut: 1,
  };
}

const trivialAgent = defineAgent({
  runner: "shutdown-test-runner",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prompt: () => "ping",
  retry: { max: 1, on: [], backoff: "fixed" },
});

const trivialWorkflow = defineWorkflow({
  name: "shutdown-test-workflow",
  tasks: {
    ping: {
      agent: trivialAgent,
      input: {},
    },
  },
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkflowExecutor — Runner.shutdown()", () => {
  afterEach(() => {
    unregisterRunner("shutdown-test-runner");
  });

  it("calls runner.shutdown() on workflow completion when defined", async () => {
    let shutdownCalled = false;

    const runner: Runner = {
      async validate() {
        return { ok: true };
      },
      async spawn() {
        return makeSpawnResult({ ok: true });
      },
      async shutdown() {
        shutdownCalled = true;
      },
    };

    registerRunner("shutdown-test-runner", runner);

    const executor = new WorkflowExecutor(trivialWorkflow);
    await executor.run();

    expect(shutdownCalled).toBe(true);
  });

  it("does not throw when runner does not implement shutdown", async () => {
    // ClaudeRunner / CodexRunner backward-compat path — no shutdown method.
    const runner: Runner = {
      async validate() {
        return { ok: true };
      },
      async spawn() {
        return makeSpawnResult({ ok: true });
      },
    };

    registerRunner("shutdown-test-runner", runner);

    const executor = new WorkflowExecutor(trivialWorkflow);
    // Must complete without throwing.
    await expect(executor.run()).resolves.toBeDefined();
  });
});
