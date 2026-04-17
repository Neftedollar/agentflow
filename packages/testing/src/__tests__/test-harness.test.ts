import {
  defineAgent,
  defineWorkflow,
  getRunners,
  registerRunner,
  unregisterRunner,
} from "@ageflow/core";
import type { Runner, RunnerSpawnResult } from "@ageflow/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestHarness } from "../test-harness.js";

// ─── Test agents ──────────────────────────────────────────────────────────────

const analyzeAgent = defineAgent({
  runner: "mock-harness",
  input: z.object({ value: z.string() }),
  output: z.object({ issues: z.array(z.string()) }),
  prompt: ({ value }) => `Analyze: ${value}`,
  retry: { max: 1, on: [], backoff: "fixed" },
});

const fixAgent = defineAgent({
  runner: "mock-harness",
  input: z.object({ issues: z.array(z.string()) }),
  output: z.object({ fixed: z.boolean() }),
  prompt: ({ issues }) => `Fix: ${issues.join(", ")}`,
  retry: { max: 1, on: [], backoff: "fixed" },
});

const retryableAgent = defineAgent({
  runner: "mock-harness",
  input: z.object({ text: z.string() }),
  output: z.object({ result: z.string() }),
  prompt: ({ text }) => `Process: ${text}`,
  // Retry on subprocess_error, up to 3 attempts
  retry: { max: 3, on: ["subprocess_error"], backoff: "fixed" },
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createTestHarness", () => {
  // ── Basic output mocking ──────────────────────────────────────────────────

  it("run() returns output from single mocked response", async () => {
    const workflow = defineWorkflow({
      name: "test-single",
      tasks: {
        analyze: {
          agent: analyzeAgent,
          input: { value: "src/" },
        },
      },
    });

    const harness = createTestHarness(workflow);
    harness.mockAgent("analyze", { issues: ["lint error", "type error"] });

    const result = await harness.run();
    expect(result.outputs.analyze).toEqual({
      issues: ["lint error", "type error"],
    });
  });

  it("run() returns output for two sequential tasks", async () => {
    const workflow = defineWorkflow({
      name: "test-sequential",
      tasks: {
        analyze: {
          agent: analyzeAgent,
          input: { value: "src/" },
        },
        fix: {
          agent: fixAgent,
          dependsOn: ["analyze"],
          input: (ctx) => ({
            issues: (ctx.analyze?.output as { issues: string[] }).issues,
          }),
        },
      },
    });

    const harness = createTestHarness(workflow);
    harness.mockAgent("analyze", { issues: ["lint error"] });
    harness.mockAgent("fix", { fixed: true });

    const result = await harness.run();
    expect(result.outputs.analyze).toEqual({ issues: ["lint error"] });
    expect(result.outputs.fix).toEqual({ fixed: true });
  });

  // ── getTask() stats ───────────────────────────────────────────────────────

  it("getTask() tracks callCount after run", async () => {
    const workflow = defineWorkflow({
      name: "test-stats",
      tasks: {
        analyze: { agent: analyzeAgent, input: { value: "x" } },
      },
    });

    const harness = createTestHarness(workflow);
    harness.mockAgent("analyze", { issues: [] });

    await harness.run();

    const stats = harness.getTask("analyze");
    expect(stats.callCount).toBe(1);
    expect(stats.outputs).toEqual([{ issues: [] }]);
    expect(stats.retryCount).toBe(0);
  });

  it("getTask() returns zeros for a task that never ran", async () => {
    const workflow = defineWorkflow({
      name: "test-no-run",
      tasks: {
        analyze: { agent: analyzeAgent, input: { value: "x" } },
      },
    });

    const harness = createTestHarness(workflow);
    harness.mockAgent("analyze", { issues: [] });
    // Do NOT call harness.run() — stats should be zeroes

    const stats = harness.getTask("analyze");
    expect(stats.callCount).toBe(0);
    expect(stats.retryCount).toBe(0);
    expect(stats.outputs).toEqual([]);
  });

  // ── Array responses ───────────────────────────────────────────────────────

  it("array responses are returned sequentially; last repeats when exhausted", async () => {
    // We need a workflow that calls the same agent multiple times.
    // Use two separate tasks with the same agent to observe sequential responses.
    const agentA = defineAgent({
      runner: "mock-harness",
      input: z.object({ n: z.number() }),
      output: z.object({ val: z.string() }),
      prompt: ({ n }) => `Task ${n}`,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const workflow = defineWorkflow({
      name: "test-sequential-responses",
      tasks: {
        t1: { agent: agentA, input: { n: 1 } },
        t2: { agent: agentA, dependsOn: ["t1"], input: { n: 2 } },
        t3: {
          agent: agentA,
          dependsOn: ["t2"],
          input: { n: 3 },
        },
      },
    });

    const harness = createTestHarness(workflow);
    // 2-element array: t1 gets first, t2 gets second, t3 gets last (repeated)
    harness.mockAgent("t1", [{ val: "first" }, { val: "second" }]);
    harness.mockAgent("t2", [{ val: "first" }, { val: "second" }]);
    harness.mockAgent("t3", [{ val: "first" }, { val: "second" }]);

    const result = await harness.run();
    // t1: callCount=1 → index 0 → "first"
    expect(result.outputs.t1).toEqual({ val: "first" });
    // t2: callCount=1 → index 0 → "first"
    expect(result.outputs.t2).toEqual({ val: "first" });
    // t3: callCount=1 → index 0 → "first"
    expect(result.outputs.t3).toEqual({ val: "first" });
  });

  it("single response repeats when task is called multiple times", async () => {
    // Use retry to force multiple calls to the same task
    // First call throws a subprocess error (which triggers retry), second succeeds
    const agentRetry = defineAgent({
      runner: "mock-harness",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ text }) => `Process: ${text}`,
      retry: { max: 3, on: ["subprocess_error"], backoff: "fixed" },
    });

    const workflow = defineWorkflow({
      name: "test-repeat",
      tasks: {
        task: { agent: agentRetry, input: { text: "hello" } },
      },
    });

    const harness = createTestHarness(workflow);
    // Single object — always returned
    harness.mockAgent("task", { result: "ok" });

    const result = await harness.run();
    expect(result.outputs.task).toEqual({ result: "ok" });

    const stats = harness.getTask("task");
    expect(stats.callCount).toBe(1);
  });

  // ── { throws: Error } response ────────────────────────────────────────────

  it("{ throws } response triggers retry on subprocess_error", async () => {
    const subprocessError = new Error("subprocess failed");
    (subprocessError as Error & { code: string }).code = "subprocess_error";

    const workflow = defineWorkflow({
      name: "test-throws-retry",
      tasks: {
        task: { agent: retryableAgent, input: { text: "hello" } },
      },
    });

    const harness = createTestHarness(workflow);
    // First call throws, second succeeds
    harness.mockAgent("task", [
      { throws: subprocessError },
      { result: "recovered" },
    ]);

    const result = await harness.run();
    expect(result.outputs.task).toEqual({ result: "recovered" });

    const stats = harness.getTask("task");
    // 2 calls: 1 throw + 1 success
    expect(stats.callCount).toBe(2);
    expect(stats.retryCount).toBe(1); // one failed call
    expect(stats.outputs).toEqual([{ result: "recovered" }]);
  });

  it("{ throws } response with no retries propagates the error", async () => {
    const nonRetryable = defineAgent({
      runner: "mock-harness",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ text }) => `Process: ${text}`,
      retry: { max: 1, on: [], backoff: "fixed" }, // no retries
    });

    const workflow = defineWorkflow({
      name: "test-throws-no-retry",
      tasks: {
        task: { agent: nonRetryable, input: { text: "hello" } },
      },
    });

    const harness = createTestHarness(workflow);
    harness.mockAgent("task", { throws: new Error("fatal error") });

    await expect(harness.run()).rejects.toThrow("fatal error");
  });

  // ── Registry isolation ────────────────────────────────────────────────────

  it("registry is restored after run — mock runner does not persist", async () => {
    // Ensure 'mock-harness' is NOT registered before the test
    unregisterRunner("mock-harness");
    const registryBefore = new Map(getRunners());

    const workflow = defineWorkflow({
      name: "test-isolation",
      tasks: {
        analyze: { agent: analyzeAgent, input: { value: "x" } },
      },
    });

    const harness = createTestHarness(workflow);
    harness.mockAgent("analyze", { issues: [] });

    await harness.run();

    // Registry should be back to what it was before run()
    const registryAfter = new Map(getRunners());
    expect(registryAfter.has("mock-harness")).toBe(
      registryBefore.has("mock-harness"),
    );
  });

  it("registry is restored after a run that throws", async () => {
    unregisterRunner("mock-harness");
    const registryBefore = new Map(getRunners());

    const workflow = defineWorkflow({
      name: "test-isolation-throw",
      tasks: {
        analyze: { agent: analyzeAgent, input: { value: "x" } },
      },
    });

    const harness = createTestHarness(workflow);
    harness.mockAgent("analyze", { throws: new Error("fatal") });

    await expect(harness.run()).rejects.toThrow("fatal");

    const registryAfter = new Map(getRunners());
    expect(registryAfter.has("mock-harness")).toBe(
      registryBefore.has("mock-harness"),
    );
  });

  it("registry is restored — pre-existing real runner is not removed", async () => {
    // Register a real (dummy) runner under a different name
    const dummyRunner: Runner = {
      validate: async () => ({ ok: true }),
      spawn: async () =>
        ({
          stdout: "{}",
          sessionHandle: "",
          tokensIn: 0,
          tokensOut: 0,
        }) as RunnerSpawnResult,
    };
    registerRunner("real-runner-preserved", dummyRunner);

    const workflow = defineWorkflow({
      name: "test-preserve-real",
      tasks: {
        analyze: { agent: analyzeAgent, input: { value: "x" } },
      },
    });

    const harness = createTestHarness(workflow);
    harness.mockAgent("analyze", { issues: [] });

    await harness.run();

    // The pre-existing runner should still be there
    expect(getRunners().has("real-runner-preserved")).toBe(true);

    // Cleanup
    unregisterRunner("real-runner-preserved");
  });

  // ── Default response when no mock registered ──────────────────────────────

  it("unregistered mock returns empty object by default, matched by z.object({})", async () => {
    const agentAny = defineAgent({
      runner: "mock-harness",
      input: z.object({}),
      output: z.object({}).passthrough(),
      prompt: () => "Hello",
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const workflow = defineWorkflow({
      name: "test-default-mock",
      tasks: {
        task: { agent: agentAny, input: {} },
      },
    });

    const harness = createTestHarness(workflow);
    // Intentionally do NOT call mockAgent — default {} response is used

    const result = await harness.run();
    expect(result.outputs.task).toEqual({});
  });

  // ── Workflow hooks ───────────────────────────────────────────────────────

  it("onWorkflowStart hook is forwarded to the executor", async () => {
    const workflowInput = { context: "test-data" };
    let receivedInput: unknown = undefined;

    const workflow = defineWorkflow({
      name: "test-onWorkflowStart",
      tasks: {
        analyze: { agent: analyzeAgent, input: { value: "src/" } },
      },
      hooks: {
        onWorkflowStart: (input: unknown) => {
          receivedInput = input;
        },
      },
    });

    const harness = createTestHarness(workflow);
    harness.mockAgent("analyze", { issues: ["test issue"] });

    await harness.run(workflowInput);

    // Assert that the hook was called with the workflow input
    expect(receivedInput).toEqual(workflowInput);
  });
});
