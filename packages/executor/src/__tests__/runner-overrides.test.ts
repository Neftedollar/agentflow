/**
 * runner-overrides.test.ts
 *
 * End-to-end tests for the #99 + #128 feature:
 *
 *  - inline tools on AgentDef (tools as a map)
 *  - runnerOverrides passed to stream()/run() for per-call tools
 *  - 3-way merge precedence: instance < agent < per-call
 *  - InlineToolsNotSupportedError from subprocess runners (codex/claude)
 *
 * Uses a fake in-process runner so no API calls are needed.
 */

import {
  InlineToolsNotSupportedError,
  defineAgent,
  defineWorkflow,
  registerRunner,
} from "@ageflow/core";
import type {
  InlineToolDef,
  Runner,
  RunnerSpawnArgs,
  RunnerSpawnResult,
} from "@ageflow/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runNode } from "../node-runner.js";
import { WorkflowExecutor } from "../workflow-executor.js";

// ─── Test runner helpers ──────────────────────────────────────────────────────

/**
 * Creates a mock runner that captures every spawn args call and returns
 * a fixed JSON-stringified result.
 */
function makeCapturingRunner(fixedOutput: unknown): {
  runner: Runner;
  spawnCalls: RunnerSpawnArgs[];
} {
  const spawnCalls: RunnerSpawnArgs[] = [];
  const runner: Runner = {
    validate: vi.fn().mockResolvedValue({ ok: true }),
    spawn: vi.fn(async (args: RunnerSpawnArgs): Promise<RunnerSpawnResult> => {
      spawnCalls.push({ ...args });
      return {
        stdout: JSON.stringify(fixedOutput),
        sessionHandle: "sess-ro-test",
        tokensIn: 5,
        tokensOut: 5,
      };
    }),
  };
  return { runner, spawnCalls };
}

function makeInlineTool<I, O>(
  description: string,
  schema: z.ZodType<I>,
  executeFn: (args: I) => Promise<O>,
): InlineToolDef<I, O> {
  return { description, parameters: schema, execute: executeFn };
}

// ─── runNode: inline tools on AgentDef ───────────────────────────────────────

describe("runNode — AgentDef.tools as inline map", () => {
  it("passes inlineTools to runner.spawn when tools is an inline map", async () => {
    const myTool = makeInlineTool(
      "my tool",
      z.object({ x: z.number() }),
      async ({ x }) => x * 2,
    );

    const agent = defineAgent({
      runner: "mock-ro",
      input: z.object({ v: z.string() }),
      output: z.object({ r: z.string() }),
      prompt: ({ v }) => `do: ${v}`,
      tools: { my_tool: myTool },
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const { runner, spawnCalls } = makeCapturingRunner({ r: "ok" });

    await runNode(
      { agent, input: { v: "hello" } },
      { v: "hello" },
      runner,
      "test-task",
    );

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    // inlineTools should contain my_tool
    expect(call?.inlineTools).toBeDefined();
    expect(Object.keys(call?.inlineTools ?? {})).toContain("my_tool");
    // tools allowlist should also be set to the map keys
    expect(call?.tools).toContain("my_tool");
  });

  it("does NOT set inlineTools when tools is a string[]", async () => {
    const agent = defineAgent({
      runner: "mock-ro",
      input: z.object({ v: z.string() }),
      output: z.object({ r: z.string() }),
      prompt: ({ v }) => `do: ${v}`,
      tools: ["some_tool"],
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const { runner, spawnCalls } = makeCapturingRunner({ r: "ok" });

    await runNode(
      { agent, input: { v: "hi" } },
      { v: "hi" },
      runner,
      "test-task",
    );

    const call = spawnCalls[0];
    // inlineTools should NOT be set — it's a string[] allowlist only
    expect(call?.inlineTools).toBeUndefined();
    // tools allowlist should still be the string[]
    expect(call?.tools).toEqual(["some_tool"]);
  });

  it("passes per-agent inline tools in inlineTools and includes keys in tools allowlist", async () => {
    const toolA = makeInlineTool(
      "tool A",
      z.object({ n: z.number() }),
      async ({ n }) => n,
    );
    const toolB = makeInlineTool(
      "tool B",
      z.object({ s: z.string() }),
      async ({ s }) => s,
    );

    const agent = defineAgent({
      runner: "mock-ro",
      input: z.object({ v: z.string() }),
      output: z.object({ r: z.string() }),
      prompt: ({ v }) => `do: ${v}`,
      tools: { tool_a: toolA, tool_b: toolB },
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const { runner, spawnCalls } = makeCapturingRunner({ r: "ok" });

    await runNode(
      { agent, input: { v: "hi" } },
      { v: "hi" },
      runner,
      "test-task",
    );

    const call = spawnCalls[0];
    expect(Object.keys(call?.inlineTools ?? {}).sort()).toEqual([
      "tool_a",
      "tool_b",
    ]);
    expect((call?.tools ?? []).slice().sort()).toEqual(["tool_a", "tool_b"]);
  });
});

// ─── runNode: runnerOverrides ─────────────────────────────────────────────────

describe("runNode — runnerOverrides (per-call tools)", () => {
  it("merges per-call tools from runnerOverrides into inlineTools", async () => {
    const perCallTool = makeInlineTool(
      "per call",
      z.object({ q: z.string() }),
      async ({ q }) => q,
    );

    const agent = defineAgent({
      runner: "mock-ro",
      input: z.object({ v: z.string() }),
      output: z.object({ r: z.string() }),
      prompt: ({ v }) => `do: ${v}`,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const { runner, spawnCalls } = makeCapturingRunner({ r: "ok" });

    await runNode(
      { agent, input: { v: "hi" } },
      { v: "hi" },
      runner,
      "test-task",
      undefined, // sessionHandle
      undefined, // permissions
      undefined, // filteredTools
      undefined, // onRetry
      undefined, // workflowMcpServers
      undefined, // hooks
      {
        "mock-ro": {
          tools: { per_call_tool: perCallTool },
        },
      },
    );

    const call = spawnCalls[0];
    expect(call?.inlineTools).toBeDefined();
    expect(Object.keys(call?.inlineTools ?? {})).toContain("per_call_tool");
    expect(call?.tools).toContain("per_call_tool");
  });

  it("per-call tools override agent-level tools with same name (per-call wins)", async () => {
    const agentTool = makeInlineTool(
      "agent-version",
      z.object({}),
      async () => "agent",
    );
    const perCallTool = makeInlineTool(
      "percall-version",
      z.object({}),
      async () => "percall",
    );

    const agent = defineAgent({
      runner: "mock-ro",
      input: z.object({ v: z.string() }),
      output: z.object({ r: z.string() }),
      prompt: ({ v }) => `do: ${v}`,
      tools: { shared_tool: agentTool },
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const { runner, spawnCalls } = makeCapturingRunner({ r: "ok" });

    await runNode(
      { agent, input: { v: "hi" } },
      { v: "hi" },
      runner,
      "test-task",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        "mock-ro": {
          tools: { shared_tool: perCallTool },
        },
      },
    );

    const call = spawnCalls[0];
    const merged = call?.inlineTools ?? {};
    // The description should reflect the per-call version winning
    // (executor merges: agent < per-call, so per-call description survives)
    expect(merged.shared_tool?.description).toBe("percall-version");
  });

  it("runnerOverrides for a different runner brand are ignored", async () => {
    const agent = defineAgent({
      runner: "mock-ro",
      input: z.object({ v: z.string() }),
      output: z.object({ r: z.string() }),
      prompt: ({ v }) => `do: ${v}`,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const { runner, spawnCalls } = makeCapturingRunner({ r: "ok" });

    await runNode(
      { agent, input: { v: "hi" } },
      { v: "hi" },
      runner,
      "test-task",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        // override for a different brand — should not affect "mock-ro"
        "other-brand": {
          tools: {
            unrelated_tool: makeInlineTool(
              "unrelated",
              z.object({}),
              async () => "x",
            ),
          },
        },
      },
    );

    const call = spawnCalls[0];
    // inlineTools should be undefined (no tools on this agent, no matching override)
    expect(call?.inlineTools).toBeUndefined();
  });

  it("runnerOverrides.sessionHandle overrides the default session handle", async () => {
    const agent = defineAgent({
      runner: "mock-ro",
      input: z.object({ v: z.string() }),
      output: z.object({ r: z.string() }),
      prompt: ({ v }) => `do: ${v}`,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const { runner, spawnCalls } = makeCapturingRunner({ r: "ok" });

    await runNode(
      { agent, input: { v: "hi" } },
      { v: "hi" },
      runner,
      "test-task",
      "old-handle", // default session handle
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        "mock-ro": {
          sessionHandle: "override-handle",
        },
      },
    );

    const call = spawnCalls[0];
    expect(call?.sessionHandle).toBe("override-handle");
  });
});

// ─── WorkflowExecutor.run() — runnerOverrides wiring ─────────────────────────

describe("WorkflowExecutor.run() — runnerOverrides end-to-end", () => {
  it("passes runnerOverrides through to runner.spawn", async () => {
    const capturedArgs: RunnerSpawnArgs[] = [];

    const mockRunner: Runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn(
        async (args: RunnerSpawnArgs): Promise<RunnerSpawnResult> => {
          capturedArgs.push({ ...args });
          return {
            stdout: JSON.stringify({ result: "done" }),
            sessionHandle: "sess-wf-ro",
            tokensIn: 5,
            tokensOut: 5,
          };
        },
      ),
    };

    registerRunner("mock-wf-ro", mockRunner);

    const agent = defineAgent({
      runner: "mock-wf-ro",
      input: z.object({ v: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ v }) => `do: ${v}`,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const workflow = defineWorkflow({
      name: "ro-test-wf",
      tasks: {
        taskA: {
          agent,
          input: { v: "hello" },
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);

    const perCallTool = makeInlineTool(
      "auth-scoped tool",
      z.object({ userId: z.string() }),
      async ({ userId }) => `token-for-${userId}`,
    );

    await executor.run(
      { v: "hello" },
      {
        runnerOverrides: {
          "mock-wf-ro": {
            tools: { auth_tool: perCallTool },
          },
        },
      },
    );

    expect(capturedArgs).toHaveLength(1);
    const spawned = capturedArgs[0];
    // The runner should have received inlineTools with auth_tool
    expect(spawned?.inlineTools).toBeDefined();
    expect(Object.keys(spawned?.inlineTools ?? {})).toContain("auth_tool");
  });

  it("run() without runnerOverrides does not break anything (regression)", async () => {
    const mockRunner: Runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ result: "ok" }),
        sessionHandle: "s",
        tokensIn: 1,
        tokensOut: 1,
      }),
    };
    registerRunner("mock-wf-noreg", mockRunner);

    const agent = defineAgent({
      runner: "mock-wf-noreg",
      input: z.object({ v: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ v }) => v,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const workflow = defineWorkflow({
      name: "noreg-wf",
      tasks: {
        t: { agent, input: { v: "x" } },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    // Should not throw
    await expect(executor.run({ v: "x" })).resolves.toBeDefined();
  });
});

// ─── InlineToolsNotSupportedError: subprocess runners ────────────────────────

describe("InlineToolsNotSupportedError — subprocess runner guard", () => {
  it("throws InlineToolsNotSupportedError with runnerName when inline tools are passed", async () => {
    // Simulate a subprocess runner that guards against inline tools
    const subprocessRunner: Runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn(
        async (args: RunnerSpawnArgs): Promise<RunnerSpawnResult> => {
          if (
            args.inlineTools !== undefined &&
            Object.keys(args.inlineTools).length > 0
          ) {
            throw new InlineToolsNotSupportedError("my-subprocess");
          }
          return {
            stdout: JSON.stringify({ r: "ok" }),
            sessionHandle: "s",
            tokensIn: 1,
            tokensOut: 1,
          };
        },
      ),
    };

    const agent = defineAgent({
      runner: "subprocess",
      input: z.object({ v: z.string() }),
      output: z.object({ r: z.string() }),
      prompt: ({ v }) => v,
      tools: {
        inline_tool: makeInlineTool("inline", z.object({}), async () => "x"),
      },
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    await expect(
      runNode(
        { agent, input: { v: "hi" } },
        { v: "hi" },
        subprocessRunner,
        "test-subprocess",
      ),
    ).rejects.toThrow(InlineToolsNotSupportedError);
  });

  it("InlineToolsNotSupportedError has code inline_tools_not_supported", () => {
    const err = new InlineToolsNotSupportedError("codex");
    expect(err.code).toBe("inline_tools_not_supported");
    expect(err.runnerName).toBe("codex");
    expect(err.message).toContain("codex");
    expect(err.message).toContain("inline tool");
  });
});
