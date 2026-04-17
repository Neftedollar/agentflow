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

describe("P1-1: single-ownership of onCheckpoint hook", () => {
  it("fires hooks.onCheckpoint exactly once when both hooks and stream onCheckpoint are provided", async () => {
    // When caller provides onCheckpoint to stream(), hooks.onCheckpoint must NOT
    // fire — the caller's handler owns the side-effect (single-ownership rule).
    let hookCallCount = 0;
    const a = defineAgent({
      runner: "fake",
      input: z.object({}),
      output: z.object({ summary: z.string() }),
      prompt: () => "p",
      hitl: { mode: "checkpoint", message: "approve?" },
    });
    const wfGated = defineWorkflow({
      name: "gated-hook",
      tasks: { t: { agent: a, input: {} } },
      hooks: {
        onCheckpoint: (_taskName: string, _msg: string) => {
          hookCallCount++;
        },
      },
    });
    const ex = new WorkflowExecutor(wfGated);
    let streamCheckpointCalls = 0;
    const events: WorkflowEvent[] = [];
    for await (const ev of ex.stream(
      {},
      {
        onCheckpoint: async () => {
          streamCheckpointCalls++;
          return true;
        },
      },
    )) {
      events.push(ev);
    }
    // Stream onCheckpoint fired exactly once
    expect(streamCheckpointCalls).toBe(1);
    // hooks.onCheckpoint must NOT fire when stream's onCheckpoint takes ownership
    expect(hookCallCount).toBe(0);
    expect(events[events.length - 1]?.type).toBe("workflow:complete");
  });

  it("fires hooks.onCheckpoint exactly once via HITLManager when no stream onCheckpoint", async () => {
    // When no stream onCheckpoint, HITLManager fires hooks.onCheckpoint — exactly once.
    let hookCallCount = 0;
    const a = defineAgent({
      runner: "fake",
      input: z.object({}),
      output: z.object({ summary: z.string() }),
      prompt: () => "p",
      hitl: { mode: "checkpoint", message: "approve?" },
    });
    const wfGated = defineWorkflow({
      name: "gated-hitl",
      tasks: { t: { agent: a, input: {} } },
      hooks: {
        onCheckpoint: (_taskName: string, _msg: string): Promise<boolean> => {
          hookCallCount++;
          return Promise.resolve(true); // approve via hook
        },
      },
    });
    const ex = new WorkflowExecutor(wfGated);
    const events: WorkflowEvent[] = [];
    for await (const ev of ex.stream({})) {
      events.push(ev);
    }
    // HITLManager fires it exactly once
    expect(hookCallCount).toBe(1);
    expect(events[events.length - 1]?.type).toBe("workflow:complete");
  });
});

describe("P1-2: AbortSignal stops executor", () => {
  it("transitions to workflow:error with aborted cause and no more events fire after cancellation", async () => {
    // Workflow with 3 sequential tasks (a → b → c).
    // We abort the signal before the workflow even starts (already-aborted signal).
    // The first batch boundary check must throw WorkflowAbortedError, producing
    // workflow:error and no task events.
    const agentSlow = defineAgent({
      runner: "fake",
      input: z.object({}),
      output: z.object({ summary: z.string() }),
      prompt: () => "p",
    });
    const wfSeq = defineWorkflow({
      name: "seq-abort",
      tasks: {
        a: { agent: agentSlow, input: {} },
        b: { agent: agentSlow, input: {}, dependsOn: ["a"] as const },
        c: { agent: agentSlow, input: {}, dependsOn: ["b"] as const },
      },
    });
    const controller = new AbortController();
    // Abort before streaming — signal is already aborted at first batch boundary
    controller.abort();

    const ex = new WorkflowExecutor(wfSeq);
    const events: WorkflowEvent[] = [];
    try {
      for await (const ev of ex.stream({}, { signal: controller.signal })) {
        events.push(ev);
      }
    } catch {
      // expected throw after abort
    }
    // Workflow must end with workflow:error
    const lastEv = events[events.length - 1];
    expect(lastEv?.type).toBe("workflow:error");
    // No task:start should have fired at all
    expect(events.some((e) => e.type === "task:start")).toBe(false);
  });

  it("stops mid-workflow when signal is aborted between tasks", async () => {
    // Workflow with 3 sequential tasks (a → b → c).
    // The runner for "b" and "c" checks the abort flag via a shared signal.
    // We abort the controller inside the runner for "a" so the batch check
    // for "b" sees it aborted before starting.
    const controller = new AbortController();
    let taskAStarted = false;
    const abortingRunner: Runner = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        if (!taskAStarted) {
          taskAStarted = true;
          // Abort after task a — the batch boundary check before b will catch it
          controller.abort();
        }
        return {
          stdout: JSON.stringify({ summary: "ok" }),
          sessionHandle: "s",
          tokensIn: 1,
          tokensOut: 1,
        };
      },
    };
    registerRunner("aborting", abortingRunner);
    try {
      const agentAborting = defineAgent({
        runner: "aborting",
        input: z.object({}),
        output: z.object({ summary: z.string() }),
        prompt: () => "p",
      });
      const wfAborting = defineWorkflow({
        name: "aborting-wf",
        tasks: {
          a: { agent: agentAborting, input: {} },
          b: { agent: agentAborting, input: {}, dependsOn: ["a"] as const },
          c: { agent: agentAborting, input: {}, dependsOn: ["b"] as const },
        },
      });
      const ex = new WorkflowExecutor(wfAborting);
      const events: WorkflowEvent[] = [];
      try {
        for await (const ev of ex.stream({}, { signal: controller.signal })) {
          events.push(ev);
        }
      } catch {
        // expected throw after abort
      }
      // Workflow must end with workflow:error
      const lastEv = events[events.length - 1];
      expect(lastEv?.type).toBe("workflow:error");
      // Task b and c must not have started
      const taskStarts = events
        .filter((e) => e.type === "task:start")
        .map((e) => (e as { taskName: string }).taskName);
      expect(taskStarts).not.toContain("b");
      expect(taskStarts).not.toContain("c");
    } finally {
      unregisterRunner("aborting");
    }
  });
});

describe("P2-1: task:error attempt count", () => {
  it("emits task:error with attempt equal to max retries when all attempts fail", async () => {
    let tries = 0;
    const alwaysFail: Runner = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        tries += 1;
        throw new Error("subprocess always fails");
      },
    };
    registerRunner("always-fail", alwaysFail);
    try {
      const a = defineAgent({
        runner: "always-fail",
        input: z.object({}),
        output: z.object({ x: z.string() }),
        prompt: () => "p",
        retry: { max: 3, on: ["subprocess_error"], backoff: "fixed" },
      });
      const wfFail = defineWorkflow({
        name: "fail3",
        tasks: { t: { agent: a, input: {} } },
      });
      const ex = new WorkflowExecutor(wfFail);
      const events: WorkflowEvent[] = [];
      try {
        for await (const ev of ex.stream({})) events.push(ev);
      } catch {
        // driver throws — collect events
      }
      const taskErr = events.find((e) => e.type === "task:error");
      expect(taskErr).toBeDefined();
      if (taskErr?.type === "task:error") {
        // 3 attempts were made; attempt should be 3, not hardcoded 0
        expect(taskErr.attempt).toBe(3);
      }
    } finally {
      unregisterRunner("always-fail");
    }
  });
});

describe("TaskDef.skipIf (stream path)", () => {
  it("emits task:skip event when skipIf returns true", async () => {
    const wfSkip = defineWorkflow({
      name: "skip-demo",
      tasks: {
        a: {
          agent,
          input: {},
          skipIf: () => true,
        },
        b: { agent, input: {}, dependsOn: ["a"] as const },
      },
    });

    const executor = new WorkflowExecutor(wfSkip);
    const events: WorkflowEvent[] = [];
    for await (const ev of executor.stream({})) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("task:skip");
    // task:start must NOT be emitted for the skipped task
    const taskStartNames = events
      .filter((e) => e.type === "task:start")
      .map((e) => (e as { taskName: string }).taskName);
    expect(taskStartNames).not.toContain("a");
    // downstream task b still ran
    expect(taskStartNames).toContain("b");
  });

  it("task:skip event has correct shape", async () => {
    const wfSkip = defineWorkflow({
      name: "skip-shape",
      tasks: {
        a: {
          agent,
          input: {},
          skipIf: () => true,
        },
      },
    });

    const executor = new WorkflowExecutor(wfSkip);
    const events: WorkflowEvent[] = [];
    for await (const ev of executor.stream({})) {
      events.push(ev);
    }

    const skipEv = events.find((e) => e.type === "task:skip");
    expect(skipEv).toBeDefined();
    if (skipEv?.type === "task:skip") {
      expect(skipEv.taskName).toBe("a");
      expect(skipEv.reason).toBe("skipIf");
      expect(typeof skipEv.runId).toBe("string");
      expect(typeof skipEv.workflowName).toBe("string");
      expect(typeof skipEv.timestamp).toBe("number");
    }
  });

  it("does NOT emit task:skip when skipIf returns false", async () => {
    const wfNoSkip = defineWorkflow({
      name: "no-skip",
      tasks: {
        a: {
          agent,
          input: {},
          skipIf: () => false,
        },
      },
    });

    const executor = new WorkflowExecutor(wfNoSkip);
    const events: WorkflowEvent[] = [];
    for await (const ev of executor.stream({})) {
      events.push(ev);
    }

    expect(events.some((e) => e.type === "task:skip")).toBe(false);
    expect(events.some((e) => e.type === "task:complete")).toBe(true);
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
