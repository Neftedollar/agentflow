import {
  defineAgent,
  defineWorkflow,
  registerRunner,
  sessionToken,
} from "@ageflow/core";
import type { Runner, RunnerSpawnResult } from "@ageflow/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BudgetTracker } from "../budget-tracker.js";
import { RunnerNotRegisteredError } from "../errors.js";
import { WorkflowExecutor } from "../workflow-executor.js";

// ─── Mock runner helpers ───────────────────────────────────────────────────────

function makeSuccessResult(
  data: unknown,
  sessionHandle = "sess-abc",
): RunnerSpawnResult {
  return {
    stdout: JSON.stringify(data),
    sessionHandle,
    tokensIn: 10,
    tokensOut: 20,
  };
}

function makeMockRunner(
  spawnImpl: (args: {
    prompt: string;
    sessionHandle?: string;
  }) => Promise<RunnerSpawnResult>,
): Runner {
  return {
    validate: vi.fn().mockResolvedValue({ ok: true }),
    spawn: vi.fn(spawnImpl),
  };
}

// ─── Test agents ──────────────────────────────────────────────────────────────

const agentA = defineAgent({
  runner: "mock-wf",
  input: z.object({ value: z.string() }),
  output: z.object({ result: z.string() }),
  prompt: ({ value }) => `Process: ${value}`,
  retry: { max: 1, on: [], backoff: "fixed" },
});

const agentB = defineAgent({
  runner: "mock-wf",
  input: z.object({ upstream: z.string() }),
  output: z.object({ final: z.string() }),
  prompt: ({ upstream }) => `Finalize: ${upstream}`,
  retry: { max: 1, on: [], backoff: "fixed" },
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkflowExecutor", () => {
  beforeEach(() => {
    // Register a fresh mock runner before each test
    const mockRunner = makeMockRunner((_args) =>
      Promise.resolve(
        makeSuccessResult(
          _args.prompt.includes("Process")
            ? { result: "output-A" }
            : { final: "output-B" },
        ),
      ),
    );
    registerRunner("mock-wf", mockRunner);
  });

  it("simple 2-task linear A→B: A output passed correctly to B input", async () => {
    let capturedBInput: unknown;

    const mockRunner = makeMockRunner((args) => {
      if (args.prompt.includes("Process")) {
        return Promise.resolve(makeSuccessResult({ result: "from-A" }));
      }
      capturedBInput = args.prompt;
      return Promise.resolve(makeSuccessResult({ final: "from-B" }));
    });
    registerRunner("mock-wf", mockRunner);

    const workflow = defineWorkflow({
      name: "test-linear",
      tasks: {
        taskA: {
          agent: agentA,
          input: { value: "initial" },
        },
        taskB: {
          agent: agentB,
          dependsOn: ["taskA"],
          input: (ctx) => ({
            upstream: (ctx.taskA?.output as { result: string }).result,
          }),
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const result = await executor.run();

    expect(result.outputs.taskA).toEqual({ result: "from-A" });
    expect(result.outputs.taskB).toEqual({ final: "from-B" });
    // B's prompt should contain "from-A" (passed via input function)
    expect(capturedBInput).toContain("from-A");
  });

  it("hooks.onTaskStart fires before each task", async () => {
    const onTaskStart = vi.fn();

    const workflow = defineWorkflow({
      name: "test-hooks-start",
      tasks: {
        taskA: { agent: agentA, input: { value: "test" } },
      },
      hooks: { onTaskStart },
    });

    const executor = new WorkflowExecutor(workflow);
    await executor.run();

    expect(onTaskStart).toHaveBeenCalledWith("taskA");
  });

  it("hooks.onTaskComplete fires after task with correct latencyMs > 0", async () => {
    const onTaskComplete = vi.fn();

    const workflow = defineWorkflow({
      name: "test-hooks-complete",
      tasks: {
        taskA: { agent: agentA, input: { value: "test" } },
      },
      hooks: { onTaskComplete },
    });

    const executor = new WorkflowExecutor(workflow);
    await executor.run();

    expect(onTaskComplete).toHaveBeenCalledTimes(1);
    const [taskName, output, metrics] = onTaskComplete.mock.calls[0] as [
      string,
      unknown,
      { latencyMs: number; tokensIn: number; tokensOut: number },
    ];
    expect(taskName).toBe("taskA");
    expect(output).toEqual({ result: "output-A" });
    expect(metrics.latencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics.tokensIn).toBe(10);
    expect(metrics.tokensOut).toBe(20);
  });

  it("hooks.onWorkflowComplete fires with aggregated metrics", async () => {
    const onWorkflowComplete = vi.fn();

    const workflow = defineWorkflow({
      name: "test-hooks-wf-complete",
      tasks: {
        taskA: { agent: agentA, input: { value: "test" } },
      },
      hooks: { onWorkflowComplete },
    });

    const executor = new WorkflowExecutor(workflow);
    await executor.run();

    expect(onWorkflowComplete).toHaveBeenCalledTimes(1);
    const [outputs, metrics] = onWorkflowComplete.mock.calls[0] as [
      unknown,
      {
        totalLatencyMs: number;
        taskCount: number;
        totalTokensIn: number;
        totalTokensOut: number;
      },
    ];
    expect(outputs).toBeDefined();
    expect(metrics.taskCount).toBe(1);
    expect(metrics.totalTokensIn).toBe(10);
    expect(metrics.totalTokensOut).toBe(20);
    expect(metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("throws RunnerNotRegisteredError when runner not in registry", async () => {
    const agentWithUnknownRunner = defineAgent({
      runner: "not-registered-runner",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "test",
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const workflow = defineWorkflow({
      name: "test-no-runner",
      tasks: {
        taskA: { agent: agentWithUnknownRunner },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    await expect(executor.run()).rejects.toThrow(RunnerNotRegisteredError);
  });

  it("budget halt: task A runs, budget exceeded, task B never runs", async () => {
    let taskBRan = false;
    const mockRunner = makeMockRunner(async (args) => {
      if (args.prompt.includes("Process")) {
        return makeSuccessResult({ result: "from-A" });
      }
      taskBRan = true;
      return makeSuccessResult({ final: "from-B" });
    });
    registerRunner("mock-wf", mockRunner);

    // Make a very expensive budget tracker pre-loaded
    const budgetTracker = new BudgetTracker();
    // Add enough cost to be over the limit
    budgetTracker.addCost("claude-sonnet-4-6", 10_000_000, 0); // $30 worth

    const workflow = defineWorkflow({
      name: "test-budget",
      tasks: {
        taskA: { agent: agentA, input: { value: "test" } },
        taskB: {
          agent: agentB,
          dependsOn: ["taskA"],
          input: (ctx) => ({
            upstream: (ctx.taskA?.output as { result: string }).result,
          }),
        },
      },
      budget: { maxCost: 1.0, onExceed: "halt" }, // $1 limit, already exceeded
    });

    const executor = new WorkflowExecutor(workflow, { budgetTracker });
    await expect(executor.run()).rejects.toThrow();
    expect(taskBRan).toBe(false);
  });

  it("session reuse: second task receives sessionHandle from first", async () => {
    const tok = sessionToken("wf-session", "mock-wf");
    const receivedHandles: (string | undefined)[] = [];

    const mockRunner = makeMockRunner(async (args) => {
      receivedHandles.push(args.sessionHandle);
      return makeSuccessResult(
        args.prompt.includes("Process") ? { result: "A" } : { final: "B" },
        "session-handle-from-A",
      );
    });
    registerRunner("mock-wf", mockRunner);

    const workflow = defineWorkflow({
      name: "test-session",
      tasks: {
        taskA: {
          agent: agentA,
          input: { value: "test" },
          session: tok,
        },
        taskB: {
          agent: agentB,
          dependsOn: ["taskA"],
          input: (ctx) => ({
            upstream: (ctx.taskA?.output as { result: string }).result,
          }),
          session: tok,
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    await executor.run();

    // taskA should not have had a prior handle (first to run)
    expect(receivedHandles[0]).toBeUndefined();
    // taskB should have received the handle from taskA
    expect(receivedHandles[1]).toBe("session-handle-from-A");
  });

  it("workflow mcpServers threaded to runNode: task with mcpOverride resolves without 'unknown server' error (#84)", async () => {
    // Capture spawn args to verify mcpServers were forwarded
    let capturedSpawnArgs: import("@ageflow/core").RunnerSpawnArgs | undefined;

    const mockRunner: import("@ageflow/core").Runner = {
      validate: vi.fn().mockResolvedValue({ ok: true }),
      spawn: vi.fn(async (args) => {
        capturedSpawnArgs = args;
        return {
          stdout: JSON.stringify({ result: "ok" }),
          sessionHandle: "s1",
          tokensIn: 5,
          tokensOut: 5,
        };
      }),
    };
    registerRunner("mock-mcp-wf", mockRunner);

    const mcpAgent = defineAgent({
      runner: "mock-mcp-wf",
      input: z.object({ value: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ value }) => `Process: ${value}`,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const workflow = defineWorkflow({
      name: "test-workflow-mcp",
      mcpServers: [{ name: "fs", command: "npx" }],
      tasks: {
        taskA: {
          agent: mcpAgent,
          input: { value: "hello" },
          mcpOverride: { servers: ["fs"] },
        },
      },
    });

    // Before the fix this would throw:
    //   "Task mcpOverride references unknown server 'fs'. Available servers: []"
    // because workflowMcpServers was not passed to runNode.
    const executor = new WorkflowExecutor(workflow);
    await expect(executor.run()).resolves.toBeDefined();

    // Verify the resolved MCP server was forwarded to the runner spawn args
    expect(capturedSpawnArgs?.mcpServers).toEqual([
      expect.objectContaining({ name: "fs" }),
    ]);
  });

  it("returns correct metrics with taskCount = number of agent tasks", async () => {
    const workflow = defineWorkflow({
      name: "test-metrics",
      tasks: {
        taskA: { agent: agentA, input: { value: "test" } },
        taskB: {
          agent: agentB,
          dependsOn: ["taskA"],
          input: (ctx) => ({
            upstream: (ctx.taskA?.output as { result: string }).result,
          }),
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const result = await executor.run();

    expect(result.metrics.taskCount).toBe(2);
    expect(result.metrics.totalTokensIn).toBe(20); // 2 tasks × 10 tokens each
    expect(result.metrics.totalTokensOut).toBe(40); // 2 tasks × 20 tokens each
  });
});
