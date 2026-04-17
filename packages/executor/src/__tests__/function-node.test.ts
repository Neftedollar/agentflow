/**
 * Tests for inline function node support in the DAG executor.
 * Covers: input/output zod validation, event emission, dependsOn, retry,
 * skipIf, and loop participation.
 */

import {
  NodeMaxRetriesError,
  defineAgent,
  defineFunction,
  defineWorkflow,
  registerRunner,
  unregisterRunner,
} from "@ageflow/core";
import type { Runner, RunnerSpawnResult, WorkflowEvent } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../workflow-executor.js";

// ─── Mock runner helpers ───────────────────────────────────────────────────────

const RUNNER = "__fn-test-mock__";

function makeMockRunner(spawnImpl?: () => Promise<RunnerSpawnResult>): Runner {
  return {
    validate: vi.fn().mockResolvedValue({ ok: true }),
    spawn: vi.fn(
      spawnImpl ??
        (() =>
          Promise.resolve({
            stdout: JSON.stringify({ result: "agent-output" }),
            sessionHandle: "sess",
            tokensIn: 5,
            tokensOut: 10,
          })),
    ),
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  registerRunner(RUNNER, makeMockRunner());
});

afterEach(() => {
  unregisterRunner(RUNNER);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("function node — basic execution", () => {
  it("runs a function task and stores output in result", async () => {
    const doubleStep = defineFunction({
      name: "double",
      input: z.object({ value: z.number() }),
      output: z.object({ doubled: z.number() }),
      execute: async ({ value }) => ({ doubled: value * 2 }),
    });

    const workflow = defineWorkflow({
      name: "fn-basic",
      tasks: {
        double: { fn: doubleStep, input: { value: 5 } },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const result = await executor.run();
    expect(result.outputs.double).toEqual({ doubled: 10 });
  });

  it("validates input through inputSchema — rejects invalid input", async () => {
    const strictFn = defineFunction({
      input: z.object({ count: z.number() }),
      output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    });

    const workflow = defineWorkflow({
      name: "fn-invalid-input",
      tasks: {
        // biome-ignore lint/suspicious/noExplicitAny: intentional bad input for test
        step: { fn: strictFn, input: { count: "not-a-number" } as any },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    await expect(executor.run()).rejects.toThrow(/input validation failed/);
  });

  it("validates output through outputSchema — rejects invalid output", async () => {
    const badFn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.string() }),
      // biome-ignore lint/suspicious/noExplicitAny: intentional bad output for test
      execute: async () => ({ result: 42 }) as any,
    });

    const workflow = defineWorkflow({
      name: "fn-invalid-output",
      tasks: {
        step: { fn: badFn, input: { x: 1 } },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    await expect(executor.run()).rejects.toThrow(/output validation failed/);
  });
});

describe("function node — event emission", () => {
  it("emits task:start, task:complete events via stream()", async () => {
    const addFn = defineFunction({
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ sum: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    });

    const workflow = defineWorkflow({
      name: "fn-events",
      tasks: {
        add: { fn: addFn, input: { a: 3, b: 4 } },
      },
    });

    const events: WorkflowEvent[] = [];
    const executor = new WorkflowExecutor(workflow);
    const gen = executor.stream();
    for await (const ev of gen) {
      events.push(ev);
    }

    const taskStart = events.find(
      (e) => e.type === "task:start" && e.taskName === "add",
    );
    const taskComplete = events.find(
      (e) => e.type === "task:complete" && e.taskName === "add",
    );

    expect(taskStart).toBeDefined();
    expect(taskComplete).toBeDefined();
    if (taskComplete?.type === "task:complete") {
      expect(taskComplete.output).toEqual({ sum: 7 });
      expect(taskComplete.metrics.tokensIn).toBe(0);
      expect(taskComplete.metrics.tokensOut).toBe(0);
      expect(taskComplete.metrics.estimatedCost).toBe(0);
    }
  });

  it("emits task:error on function task failure", async () => {
    const failingFn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async () => {
        throw new Error("function crashed");
      },
    });

    const workflow = defineWorkflow({
      name: "fn-error-event",
      tasks: {
        step: { fn: failingFn, input: { x: 1 } },
      },
    });

    const events: WorkflowEvent[] = [];
    const executor = new WorkflowExecutor(workflow);
    const gen = executor.stream();
    try {
      for await (const ev of gen) {
        events.push(ev);
      }
    } catch {
      // expected
    }

    const errorEv = events.find(
      (e) => e.type === "task:error" && e.taskName === "step",
    );
    expect(errorEv).toBeDefined();
    if (errorEv?.type === "task:error") {
      // NodeMaxRetriesError wraps the last error message
      expect(errorEv.error.message).toContain("function crashed");
      expect(errorEv.terminal).toBe(true);
    }
  });
});

describe("function node — dependsOn + ctx flow", () => {
  it("downstream function task receives output of upstream agent task", async () => {
    const agentDef = defineAgent({
      runner: RUNNER,
      input: z.object({ prompt: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ prompt }) => prompt,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    registerRunner(
      RUNNER,
      makeMockRunner(() =>
        Promise.resolve({
          stdout: JSON.stringify({ result: "agent-result" }),
          sessionHandle: "",
          tokensIn: 1,
          tokensOut: 1,
        }),
      ),
    );

    const processFn = defineFunction({
      input: z.object({ text: z.string() }),
      output: z.object({ upper: z.string() }),
      execute: async ({ text }) => ({ upper: text.toUpperCase() }),
    });

    const workflow = defineWorkflow({
      name: "fn-depends-on-agent",
      tasks: {
        agentTask: { agent: agentDef, input: { prompt: "hello" } },
        processTask: {
          fn: processFn,
          dependsOn: ["agentTask"],
          input: (ctx) => ({
            text: (ctx.agentTask?.output as { result: string }).result,
          }),
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const result = await executor.run();
    expect(result.outputs.processTask).toEqual({ upper: "AGENT-RESULT" });
  });

  it("agent task downstream of function task receives function output", async () => {
    const formatFn = defineFunction({
      input: z.object({ items: z.array(z.string()) }),
      output: z.object({ csv: z.string() }),
      execute: async ({ items }) => ({ csv: items.join(",") }),
    });

    let capturedPrompt = "";
    registerRunner(
      RUNNER,
      makeMockRunner((args) => {
        capturedPrompt = (args as { prompt: string }).prompt;
        return Promise.resolve({
          stdout: JSON.stringify({ result: "ok" }),
          sessionHandle: "",
          tokensIn: 1,
          tokensOut: 1,
        });
      }),
    );

    const agentDef = defineAgent({
      runner: RUNNER,
      input: z.object({ data: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ data }) => `Process: ${data}`,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    const workflow = defineWorkflow({
      name: "agent-depends-on-fn",
      tasks: {
        format: { fn: formatFn, input: { items: ["a", "b", "c"] } },
        process: {
          agent: agentDef,
          dependsOn: ["format"],
          input: (ctx) => ({
            data: (ctx.format?.output as { csv: string }).csv,
          }),
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    await executor.run();
    expect(capturedPrompt).toContain("a,b,c");
  });
});

describe("function node — skipIf", () => {
  it("skips function task when skipIf returns true", async () => {
    const executeSpy = vi.fn(async () => ({ result: "done" }));
    const fnDef = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.string() }),
      execute: executeSpy,
    });

    const workflow = defineWorkflow({
      name: "fn-skip",
      tasks: {
        step: {
          fn: fnDef,
          input: { x: 1 },
          skipIf: () => true,
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const result = await executor.run();
    expect(result.outputs.step).toBeUndefined();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("runs function task when skipIf returns false", async () => {
    const fnDef = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ doubled: z.number() }),
      execute: async ({ x }) => ({ doubled: x * 2 }),
    });

    const workflow = defineWorkflow({
      name: "fn-no-skip",
      tasks: {
        step: {
          fn: fnDef,
          input: { x: 3 },
          skipIf: () => false,
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const result = await executor.run();
    expect(result.outputs.step).toEqual({ doubled: 6 });
  });
});

describe("function node — retry", () => {
  it("retries on thrown error when error kind is in retry.on", async () => {
    let callCount = 0;
    const flakyFn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async ({ x }) => {
        callCount++;
        if (callCount < 3) {
          throw new Error("transient failure");
        }
        return { result: x * 2 };
      },
    });

    const workflow = defineWorkflow({
      name: "fn-retry",
      tasks: {
        step: {
          fn: flakyFn,
          input: { x: 5 },
          // "transient" covers any non-timeout, non-validation error from execute()
          retry: { max: 3, on: ["transient"], backoff: "fixed" },
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const result = await executor.run();
    expect(callCount).toBe(3);
    expect(result.outputs.step).toEqual({ result: 10 });
  });

  it("throws NodeMaxRetriesError after exhausting retry attempts", async () => {
    const alwaysFails = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async () => {
        throw new Error("always fails");
      },
    });

    const workflow = defineWorkflow({
      name: "fn-retry-exhaust",
      tasks: {
        step: {
          fn: alwaysFails,
          input: { x: 1 },
          retry: { max: 2, on: ["transient"], backoff: "fixed" },
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const err = await executor.run().catch((e) => e);
    expect(err).toBeInstanceOf(NodeMaxRetriesError);
    expect((err as NodeMaxRetriesError).attempts).toHaveLength(2);
  });

  it("emits task:retry events on retries via stream()", async () => {
    let attempts = 0;
    const flakyFn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async ({ x }) => {
        attempts++;
        if (attempts < 2) throw new Error("retry me");
        return { result: x };
      },
    });

    const workflow = defineWorkflow({
      name: "fn-retry-events",
      tasks: {
        step: {
          fn: flakyFn,
          input: { x: 7 },
          retry: { max: 3, on: ["transient"], backoff: "fixed" },
        },
      },
    });

    const events: WorkflowEvent[] = [];
    const executor = new WorkflowExecutor(workflow);
    for await (const ev of executor.stream()) {
      events.push(ev);
    }

    const retryEv = events.find(
      (e) => e.type === "task:retry" && e.taskName === "step",
    );
    expect(retryEv).toBeDefined();
    if (retryEv?.type === "task:retry") {
      expect(retryEv.attempt).toBe(1);
    }
  });

  it("onTaskError receives correct attempt count after retry exhaustion", async () => {
    const alwaysFails = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async () => {
        throw new Error("always fails");
      },
    });

    const onTaskError = vi.fn();

    const workflow = defineWorkflow({
      name: "fn-retry-attempt-count",
      tasks: {
        step: {
          fn: alwaysFails,
          input: { x: 1 },
          retry: { max: 3, on: ["transient"], backoff: "fixed" },
        },
      },
      hooks: { onTaskError },
    });

    const executor = new WorkflowExecutor(workflow);
    await expect(executor.run()).rejects.toBeInstanceOf(NodeMaxRetriesError);

    expect(onTaskError).toHaveBeenCalledTimes(1);
    const [, , attemptCount] = onTaskError.mock.calls[0] as [
      string,
      Error,
      number,
    ];
    expect(attemptCount).toBe(3);
  });

  it("task:error event has attempt: 3 after 3-attempt retry exhaustion via stream()", async () => {
    const alwaysFails = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async () => {
        throw new Error("always fails");
      },
    });

    const workflow = defineWorkflow({
      name: "fn-retry-attempt-count-event",
      tasks: {
        step: {
          fn: alwaysFails,
          input: { x: 1 },
          retry: { max: 3, on: ["transient"], backoff: "fixed" },
        },
      },
    });

    const events: WorkflowEvent[] = [];
    const executor = new WorkflowExecutor(workflow);
    try {
      for await (const ev of executor.stream()) {
        events.push(ev);
      }
    } catch {
      // expected
    }

    const errorEv = events.find(
      (e) => e.type === "task:error" && e.taskName === "step",
    );
    expect(errorEv).toBeDefined();
    if (errorEv?.type === "task:error") {
      expect(errorEv.attempt).toBe(3);
      expect(errorEv.terminal).toBe(true);
    }
  });
});

describe("function node — hooks", () => {
  it("fires onTaskStart and onTaskComplete hooks", async () => {
    const fn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async ({ x }) => ({ result: x + 1 }),
    });

    const onTaskStart = vi.fn();
    const onTaskComplete = vi.fn();

    const workflow = defineWorkflow({
      name: "fn-hooks",
      tasks: {
        step: { fn, input: { x: 10 } },
      },
      hooks: { onTaskStart, onTaskComplete },
    });

    await new WorkflowExecutor(workflow).run();
    expect(onTaskStart).toHaveBeenCalledWith("step", "");
    expect(onTaskComplete).toHaveBeenCalledWith(
      "step",
      { result: 11 },
      expect.objectContaining({
        tokensIn: 0,
        tokensOut: 0,
        estimatedCost: 0,
      }),
    );
  });

  it("fires onTaskSkip hook when skipIf returns true", async () => {
    const fn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async ({ x }) => ({ result: x }),
    });

    const onTaskSkip = vi.fn();

    const workflow = defineWorkflow({
      name: "fn-skip-hook",
      tasks: {
        step: { fn, input: { x: 1 }, skipIf: () => true },
      },
      hooks: { onTaskSkip },
    });

    await new WorkflowExecutor(workflow).run();
    expect(onTaskSkip).toHaveBeenCalledWith("step", "skipIf");
  });
});

describe("function node — retry.on classification", () => {
  it("retry.on=[] — does NOT retry on any error (single attempt)", async () => {
    // With on: [] the retry set is empty — no error kind is retryable.
    // execute() should be called exactly once even though max=3.
    let callCount = 0;
    const flakyFn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async () => {
        callCount++;
        throw new Error("transient failure");
      },
    });

    const workflow = defineWorkflow({
      name: "fn-retry-on-empty",
      tasks: {
        step: {
          fn: flakyFn,
          input: { x: 5 },
          retry: { max: 3, on: [], backoff: "fixed" },
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const err = await executor.run().catch((e) => e);
    expect(err).toBeInstanceOf(NodeMaxRetriesError);
    // Called exactly once — no retries
    expect(callCount).toBe(1);
    expect((err as NodeMaxRetriesError).attempts).toHaveLength(1);
  });

  it('retry.on=["timeout"] with non-timeout error — does NOT retry', async () => {
    // "transient" errors are not in retry.on, so no retry happens.
    let callCount = 0;
    const flakyFn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async () => {
        callCount++;
        throw new Error("generic error — not a timeout");
      },
    });

    const workflow = defineWorkflow({
      name: "fn-retry-on-timeout-no-match",
      tasks: {
        step: {
          fn: flakyFn,
          input: { x: 1 },
          retry: { max: 3, on: ["timeout"], backoff: "fixed" },
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const err = await executor.run().catch((e) => e);
    expect(err).toBeInstanceOf(NodeMaxRetriesError);
    // Called exactly once — "transient" not in retry.on
    expect(callCount).toBe(1);
    expect((err as NodeMaxRetriesError).attempts).toHaveLength(1);
  });

  it('retry.on=["timeout"] with TimeoutError — retries up to max', async () => {
    // TimeoutError is classified as "timeout" — present in retry.on → retries happen.
    const { TimeoutError } = await import("@ageflow/core");
    let callCount = 0;
    const flakyFn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.number() }),
      execute: async ({ x }) => {
        callCount++;
        if (callCount < 3) {
          throw new TimeoutError("step", 100);
        }
        return { result: x };
      },
    });

    const workflow = defineWorkflow({
      name: "fn-retry-on-timeout-match",
      tasks: {
        step: {
          fn: flakyFn,
          input: { x: 7 },
          retry: { max: 3, on: ["timeout"], backoff: "fixed" },
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const result = await executor.run();
    // Retried twice (attempts 1 and 2 failed), third succeeded
    expect(callCount).toBe(3);
    expect(result.outputs.step).toEqual({ result: 7 });
  });

  it("zod validation errors are never retried even when retry.max > 1", async () => {
    let callCount = 0;
    const badOutputFn = defineFunction({
      input: z.object({ x: z.number() }),
      output: z.object({ result: z.string() }),
      execute: async () => {
        callCount++;
        // biome-ignore lint/suspicious/noExplicitAny: intentional bad output for test
        return { result: 42 } as any;
      },
    });

    const workflow = defineWorkflow({
      name: "fn-zod-no-retry",
      tasks: {
        step: {
          fn: badOutputFn,
          input: { x: 1 },
          retry: { max: 3, on: ["transient"], backoff: "fixed" },
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    await expect(executor.run()).rejects.toThrow(/output validation failed/);
    // Only called once — validation errors are not retried
    expect(callCount).toBe(1);
  });
});

describe("function node — mixed workflow (fn → agent → fn)", () => {
  it("runs a 3-step fn → agent → fn pipeline end-to-end", async () => {
    // Step 1: pure fn — prepares data
    const prepareFn = defineFunction({
      name: "prepare",
      input: z.object({ raw: z.string() }),
      output: z.object({ cleaned: z.string() }),
      execute: async ({ raw }) => ({ cleaned: raw.trim().toLowerCase() }),
    });

    // Step 2: agent — processes cleaned data
    const agentDef = defineAgent({
      runner: RUNNER,
      input: z.object({ data: z.string() }),
      output: z.object({ processed: z.string() }),
      prompt: ({ data }) => `Process: ${data}`,
      retry: { max: 1, on: [], backoff: "fixed" },
    });

    registerRunner(
      RUNNER,
      makeMockRunner(() =>
        Promise.resolve({
          stdout: JSON.stringify({ processed: "processed-result" }),
          sessionHandle: "",
          tokensIn: 2,
          tokensOut: 3,
        }),
      ),
    );

    // Step 3: pure fn — formats output
    const formatFn = defineFunction({
      name: "format",
      input: z.object({ text: z.string() }),
      output: z.object({ final: z.string() }),
      execute: async ({ text }) => ({ final: `[${text.toUpperCase()}]` }),
    });

    const workflow = defineWorkflow({
      name: "mixed-fn-agent-fn",
      tasks: {
        prepare: { fn: prepareFn, input: { raw: "  Hello World  " } },
        process: {
          agent: agentDef,
          dependsOn: ["prepare"],
          input: (ctx) => ({
            data: (ctx.prepare?.output as { cleaned: string }).cleaned,
          }),
        },
        format: {
          fn: formatFn,
          dependsOn: ["process"],
          input: (ctx) => ({
            text: (ctx.process?.output as { processed: string }).processed,
          }),
        },
      },
    });

    const executor = new WorkflowExecutor(workflow);
    const result = await executor.run();

    expect(result.outputs.prepare).toEqual({ cleaned: "hello world" });
    expect(result.outputs.process).toEqual({ processed: "processed-result" });
    expect(result.outputs.format).toEqual({ final: "[PROCESSED-RESULT]" });
  });
});
