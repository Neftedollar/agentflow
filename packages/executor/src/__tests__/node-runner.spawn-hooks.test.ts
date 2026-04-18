import { defineAgent } from "@ageflow/core";
import type {
  RunnerSpawnArgs,
  RunnerSpawnResult,
  WorkflowHooks,
} from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runNode } from "../node-runner.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSuccessResult(data: unknown): RunnerSpawnResult {
  return {
    stdout: JSON.stringify(data),
    sessionHandle: "sess-spawn-hook",
    tokensIn: 5,
    tokensOut: 10,
  };
}

const simpleAgent = defineAgent({
  runner: "mock",
  input: z.object({ text: z.string() }),
  output: z.object({ result: z.string() }),
  prompt: ({ text }) => `Process: ${text}`,
  retry: { max: 1, on: [], backoff: "fixed" },
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runNode — onTaskSpawnArgs / onTaskSpawnResult hooks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("onTaskSpawnArgs fires with correct taskName and args before spawn", async () => {
    const captured: { taskName: string; args: RunnerSpawnArgs }[] = [];

    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn().mockResolvedValue(makeSuccessResult({ result: "ok" })),
    };

    const hooks: WorkflowHooks = {
      onTaskSpawnArgs: (taskName, args) => {
        captured.push({ taskName, args });
      },
    };

    await Promise.all([
      runNode(
        { agent: simpleAgent },
        { text: "hello" },
        runner,
        "my-task",
        undefined,
        { hooks },
      ),
      vi.runAllTimersAsync(),
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0].taskName).toBe("my-task");
    expect(captured[0].args.prompt).toContain("hello");
    expect(captured[0].args.taskName).toBe("my-task");
  });

  it("onTaskSpawnArgs fires before runner.spawn (ordering)", async () => {
    const order: string[] = [];

    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn(async () => {
        order.push("spawn");
        return makeSuccessResult({ result: "ok" });
      }),
    };

    const hooks: WorkflowHooks = {
      onTaskSpawnArgs: (_taskName, _args) => {
        order.push("onTaskSpawnArgs");
      },
      onTaskSpawnResult: (_taskName, _result) => {
        order.push("onTaskSpawnResult");
      },
    };

    await Promise.all([
      runNode(
        { agent: simpleAgent },
        { text: "hello" },
        runner,
        "order-task",
        undefined,
        { hooks },
      ),
      vi.runAllTimersAsync(),
    ]);

    expect(order).toEqual(["onTaskSpawnArgs", "spawn", "onTaskSpawnResult"]);
  });

  it("onTaskSpawnResult fires with correct taskName and result after spawn", async () => {
    const captured: { taskName: string; result: RunnerSpawnResult }[] = [];

    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn().mockResolvedValue(makeSuccessResult({ result: "done" })),
    };

    const hooks: WorkflowHooks = {
      onTaskSpawnResult: (taskName, result) => {
        captured.push({ taskName, result });
      },
    };

    await Promise.all([
      runNode(
        { agent: simpleAgent },
        { text: "hello" },
        runner,
        "result-task",
        undefined,
        { hooks },
      ),
      vi.runAllTimersAsync(),
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0].taskName).toBe("result-task");
    expect(captured[0].result.stdout).toBe(JSON.stringify({ result: "done" }));
    expect(captured[0].result.sessionHandle).toBe("sess-spawn-hook");
    expect(captured[0].result.tokensIn).toBe(5);
    expect(captured[0].result.tokensOut).toBe(10);
  });

  it("onTaskSpawnArgs error does NOT crash the task (best-effort)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn().mockResolvedValue(makeSuccessResult({ result: "ok" })),
    };

    const hooks: WorkflowHooks = {
      onTaskSpawnArgs: (_taskName, _args) => {
        throw new Error("hook exploded");
      },
    };

    const [nodeResult] = await Promise.all([
      runNode(
        { agent: simpleAgent },
        { text: "hello" },
        runner,
        "safe-task",
        undefined,
        { hooks },
      ),
      vi.runAllTimersAsync(),
    ]);

    // Task still succeeded despite hook error
    expect(nodeResult.output).toEqual({ result: "ok" });
    // Warning was logged
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("onTaskSpawnArgs");
  });

  it("onTaskSpawnResult error does NOT crash the task (best-effort)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn().mockResolvedValue(makeSuccessResult({ result: "ok" })),
    };

    const hooks: WorkflowHooks = {
      onTaskSpawnResult: (_taskName, _result) => {
        throw new Error("result hook exploded");
      },
    };

    const [nodeResult] = await Promise.all([
      runNode(
        { agent: simpleAgent },
        { text: "hello" },
        runner,
        "safe-result-task",
        undefined,
        { hooks },
      ),
      vi.runAllTimersAsync(),
    ]);

    expect(nodeResult.output).toEqual({ result: "ok" });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("onTaskSpawnResult");
  });

  it("hooks do not fire when not provided", async () => {
    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn().mockResolvedValue(makeSuccessResult({ result: "ok" })),
    };

    // No hooks — should complete without error
    const [nodeResult] = await Promise.all([
      runNode({ agent: simpleAgent }, { text: "hello" }, runner, "no-hooks"),
      vi.runAllTimersAsync(),
    ]);

    expect(nodeResult.output).toEqual({ result: "ok" });
  });

  it("hooks are called per-retry attempt", async () => {
    const spawnArgsCalls: string[] = [];
    const spawnResultCalls: string[] = [];

    const retryableAgent = defineAgent({
      runner: "mock",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ text }) => `Process: ${text}`,
      retry: { max: 3, on: ["subprocess_error"], backoff: "fixed" },
    });

    let callCount = 0;
    const subprocessErr = Object.assign(new Error("subprocess error"), {
      code: "subprocess_error",
    });

    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn(async () => {
        callCount++;
        if (callCount < 2) throw subprocessErr;
        return makeSuccessResult({ result: "ok" });
      }),
    };

    const hooks: WorkflowHooks = {
      onTaskSpawnArgs: (taskName) => {
        spawnArgsCalls.push(taskName);
      },
      onTaskSpawnResult: (taskName) => {
        spawnResultCalls.push(taskName);
      },
    };

    await Promise.all([
      runNode(
        { agent: retryableAgent },
        { text: "hello" },
        runner,
        "retry-task",
        undefined,
        { hooks },
      ),
      vi.runAllTimersAsync(),
    ]);

    // onTaskSpawnArgs fires on every attempt (including the failing one)
    expect(spawnArgsCalls).toHaveLength(2);
    // onTaskSpawnResult fires only on the successful attempt
    expect(spawnResultCalls).toHaveLength(1);
  });

  it("async onTaskSpawnArgs that rejects after a tick is caught — workflow does not crash", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn().mockResolvedValue(makeSuccessResult({ result: "ok" })),
    };

    const hooks: WorkflowHooks = {
      onTaskSpawnArgs: async (_taskName, _args) => {
        // Simulate async work before throwing
        await Promise.resolve();
        throw new Error("async hook exploded");
      },
    };

    const [nodeResult] = await Promise.all([
      runNode(
        { agent: simpleAgent },
        { text: "hello" },
        runner,
        "async-args-throw-task",
        undefined,
        { hooks },
      ),
      vi.runAllTimersAsync(),
    ]);

    // Task still succeeded despite async hook rejection
    expect(nodeResult.output).toEqual({ result: "ok" });
    // Warning was logged
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("onTaskSpawnArgs");
  });

  it("async onTaskSpawnResult that rejects after a tick is caught — workflow does not crash", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn().mockResolvedValue(makeSuccessResult({ result: "ok" })),
    };

    const hooks: WorkflowHooks = {
      onTaskSpawnResult: async (_taskName, _result) => {
        await Promise.resolve();
        throw new Error("async result hook exploded");
      },
    };

    const [nodeResult] = await Promise.all([
      runNode(
        { agent: simpleAgent },
        { text: "hello" },
        runner,
        "async-result-throw-task",
        undefined,
        { hooks },
      ),
      vi.runAllTimersAsync(),
    ]);

    expect(nodeResult.output).toEqual({ result: "ok" });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("onTaskSpawnResult");
  });

  it("async onTaskSpawnArgs that resolves — spawn proceeds normally, result observed", async () => {
    const resolved: string[] = [];

    const runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi
        .fn()
        .mockResolvedValue(makeSuccessResult({ result: "async-ok" })),
    };

    const hooks: WorkflowHooks = {
      onTaskSpawnArgs: async (taskName, _args) => {
        await Promise.resolve();
        resolved.push(`args:${taskName}`);
      },
      onTaskSpawnResult: async (taskName, _result) => {
        await Promise.resolve();
        resolved.push(`result:${taskName}`);
      },
    };

    const [nodeResult] = await Promise.all([
      runNode(
        { agent: simpleAgent },
        { text: "hello" },
        runner,
        "async-resolve-task",
        undefined,
        { hooks },
      ),
      vi.runAllTimersAsync(),
    ]);

    expect(nodeResult.output).toEqual({ result: "async-ok" });
    // Both async hooks resolved and were awaited before proceeding
    expect(resolved).toEqual([
      "args:async-resolve-task",
      "result:async-resolve-task",
    ]);
  });
});
