import {
  defineAgent,
  defineWorkflow,
  registerRunner,
  unregisterRunner,
} from "@ageflow/core";
import type { Runner, WorkflowEvent } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../workflow-executor.js";

const fakeRunner: Runner = {
  validate: async () => ({ ok: true }),
  spawn: async () => ({
    stdout: JSON.stringify({ summary: "ok" }),
    sessionHandle: "s",
    tokensIn: 1,
    tokensOut: 2,
  }),
};

const agent = defineAgent({
  runner: "fake",
  input: z.object({}),
  output: z.object({ summary: z.string() }),
  prompt: () => "go",
});

const wf = defineWorkflow({
  name: "demo",
  tasks: {
    a: { agent, input: {} },
    b: { agent, input: {}, dependsOn: ["a"] as const },
  },
});

beforeEach(() => registerRunner("fake", fakeRunner));
afterEach(() => unregisterRunner("fake"));

describe("WorkflowExecutor.stream (happy path)", () => {
  it("yields workflow:start → task:start/task:complete × 2 → workflow:complete", async () => {
    const executor = new WorkflowExecutor(wf);
    const events: WorkflowEvent[] = [];
    const gen = executor.stream({});
    let result: IteratorResult<WorkflowEvent, unknown>;
    do {
      result = await gen.next();
      if (!result.done) events.push(result.value);
    } while (!result.done);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("workflow:start");
    expect(types).toContain("task:start");
    expect(types).toContain("task:complete");
    expect(types[types.length - 1]).toBe("workflow:complete");
    // Exactly 2 task:start / 2 task:complete
    expect(types.filter((t) => t === "task:start").length).toBe(2);
    expect(types.filter((t) => t === "task:complete").length).toBe(2);
    // All events share the same runId and workflowName === "demo"
    const runIds = new Set(events.map((e) => e.runId));
    expect(runIds.size).toBe(1);
    for (const e of events) expect(e.workflowName).toBe("demo");
  });
});

describe("WorkflowExecutor.stream (task failure)", () => {
  it("emits task:error with terminal:true and a terminal workflow:error", async () => {
    const boom: Runner = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        throw new Error("subprocess failure");
      },
    };
    registerRunner("boom", boom);
    try {
      const a = defineAgent({
        runner: "boom",
        input: z.object({}),
        output: z.object({ x: z.string() }),
        prompt: () => "go",
        retry: { max: 1, on: ["subprocess_error"], backoff: "fixed" },
      });
      const wfx = defineWorkflow({
        name: "bad",
        tasks: { t: { agent: a, input: {} } },
      });
      const executor = new WorkflowExecutor(wfx);
      const events: WorkflowEvent[] = [];
      const gen = executor.stream({});
      try {
        for await (const ev of gen) events.push(ev);
      } catch {
        // driver throws — we still collected the events
      }
      const taskErr = events.find((e) => e.type === "task:error");
      expect(taskErr).toBeDefined();
      if (taskErr?.type === "task:error") {
        expect(taskErr.terminal).toBe(true);
      }
      expect(events[events.length - 1]?.type).toBe("workflow:error");
    } finally {
      unregisterRunner("boom");
    }
  });
});

describe("WorkflowExecutor.stream (task retry)", () => {
  it("emits task:retry between transient failures", async () => {
    let tries = 0;
    const runner: Runner = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        tries += 1;
        if (tries < 2) throw new Error("subprocess flake");
        return {
          stdout: JSON.stringify({ x: "ok" }),
          sessionHandle: "s",
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    };
    registerRunner("flaky", runner);
    try {
      const a = defineAgent({
        runner: "flaky",
        input: z.object({}),
        output: z.object({ x: z.string() }),
        prompt: () => "p",
        retry: { max: 3, on: ["subprocess_error"], backoff: "fixed" },
      });
      const wfy = defineWorkflow({
        name: "r",
        tasks: { t: { agent: a, input: {} } },
      });
      const ex = new WorkflowExecutor(wfy);
      const events: WorkflowEvent[] = [];
      for await (const ev of ex.stream({})) events.push(ev);
      expect(events.some((e) => e.type === "task:retry")).toBe(true);
    } finally {
      unregisterRunner("flaky");
    }
  });
});

describe("stream() onCheckpoint", () => {
  it("continues when onCheckpoint resolves true", async () => {
    const a = defineAgent({
      runner: "fake",
      input: z.object({}),
      output: z.object({ summary: z.string() }),
      prompt: () => "p",
      hitl: { mode: "checkpoint", message: "go?" },
    });
    const wfz = defineWorkflow({
      name: "gated",
      tasks: { t: { agent: a, input: {} } },
    });
    const ex = new WorkflowExecutor(wfz);
    const events: WorkflowEvent[] = [];
    for await (const ev of ex.stream({}, { onCheckpoint: async () => true })) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toContain("checkpoint");
    expect(events[events.length - 1]?.type).toBe("workflow:complete");
  });

  it("fails with workflow:error when onCheckpoint resolves false", async () => {
    const a = defineAgent({
      runner: "fake",
      input: z.object({}),
      output: z.object({ summary: z.string() }),
      prompt: () => "p",
      hitl: { mode: "checkpoint", message: "go?" },
    });
    const wfz = defineWorkflow({
      name: "gated",
      tasks: { t: { agent: a, input: {} } },
    });
    const ex = new WorkflowExecutor(wfz);
    const events: WorkflowEvent[] = [];
    try {
      for await (const ev of ex.stream(
        {},
        { onCheckpoint: async () => false },
      )) {
        events.push(ev);
      }
    } catch {
      // expected — driver throws
    }
    expect(events[events.length - 1]?.type).toBe("workflow:error");
  });
});

describe("run() is a drain over stream()", () => {
  it("produces the same WorkflowResult as draining stream()", async () => {
    const executor = new WorkflowExecutor(wf);
    const runResult = await executor.run({});

    const executor2 = new WorkflowExecutor(wf);
    const gen = executor2.stream({});
    let streamResult: IteratorResult<WorkflowEvent, unknown>;
    do {
      streamResult = await gen.next();
    } while (!streamResult.done);

    expect(runResult.outputs).toEqual(
      (streamResult.value as { outputs: unknown }).outputs,
    );
    expect(runResult.metrics.taskCount).toBe(
      (streamResult.value as { metrics: { taskCount: number } }).metrics
        .taskCount,
    );
  });
});
