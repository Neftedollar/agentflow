import { defineAgent, sessionToken } from "@ageflow/core";
import type { LoopDef, TasksMap } from "@ageflow/core";
import { LoopMaxIterationsError } from "@ageflow/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LoopExecutor } from "../loop-executor.js";
import type { SessionManager } from "../session-manager.js";
import type { CtxEntry, RunBatchesFn } from "../types-internal.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const dummyAgent = defineAgent({
  runner: "claude",
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  prompt: () => "test",
});

function makeLoopDef(
  overrides: Partial<Omit<LoopDef<TasksMap>, "kind">> & {
    tasks?: TasksMap;
    until?: (ctx: unknown) => boolean;
  } = {},
): LoopDef<TasksMap> {
  return {
    kind: "loop",
    max: 5,
    until: (_ctx) => false,
    tasks: {
      task1: { agent: dummyAgent },
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("LoopExecutor", () => {
  it("runs exactly once when until() returns true on first iteration", async () => {
    const runBatches = vi.fn().mockResolvedValue({
      task1: { output: { done: true }, _source: "agent" },
    });
    const executor = new LoopExecutor(runBatches as RunBatchesFn);

    const loopDef = makeLoopDef({
      until: () => true, // always true
      max: 5,
    });

    await executor.run(loopDef, {}, "my-loop");
    expect(runBatches).toHaveBeenCalledTimes(1);
  });

  it("runs N times when until() returns true on iteration N-1", async () => {
    let callCount = 0;
    const runBatches = vi.fn().mockImplementation(async () => {
      callCount++;
      return { task1: { output: { done: callCount >= 3 }, _source: "agent" } };
    });
    const executor = new LoopExecutor(runBatches as RunBatchesFn);

    const loopDef = makeLoopDef({
      until: (ctx) => {
        const c = ctx as Record<string, CtxEntry>;
        return (
          (c.task1?.output as { done: boolean } | undefined)?.done === true
        );
      },
      max: 10,
    });

    await executor.run(loopDef, {}, "my-loop");
    expect(callCount).toBe(3);
    expect(runBatches).toHaveBeenCalledTimes(3);
  });

  it("throws LoopMaxIterationsError after max iterations without until() returning true", async () => {
    const runBatches = vi.fn().mockResolvedValue({
      task1: { output: { done: false }, _source: "agent" },
    });
    const executor = new LoopExecutor(runBatches as RunBatchesFn);

    const loopDef = makeLoopDef({
      until: () => false, // never exits
      max: 3,
    });

    await expect(executor.run(loopDef, {}, "stuck-loop")).rejects.toThrow(
      LoopMaxIterationsError,
    );
    expect(runBatches).toHaveBeenCalledTimes(3);
  });

  it("LoopMaxIterationsError contains taskName and max", async () => {
    const runBatches = vi.fn().mockResolvedValue({
      task1: { output: { done: false }, _source: "agent" },
    });
    const executor = new LoopExecutor(runBatches as RunBatchesFn);
    const loopDef = makeLoopDef({ until: () => false, max: 2 });

    let caught: LoopMaxIterationsError | undefined;
    try {
      await executor.run(loopDef, {}, "named-loop");
    } catch (e) {
      if (e instanceof LoopMaxIterationsError) {
        caught = e;
      }
    }
    expect(caught?.taskName).toBe("named-loop");
    expect(caught?.maxIterations).toBe(2);
  });

  it("context: 'fresh' — each iteration receives a new SessionManager with no prior handles", async () => {
    // With context: "fresh", LoopExecutor creates a new SessionManager per iteration.
    // The SM passed as 3rd arg to runBatches should have no handles at iteration start.
    const tok = sessionToken("loop-session", "claude");
    const innerTasks: TasksMap = {
      fix: { agent: dummyAgent, session: tok },
    };

    let iteration = 0;
    const handlesSeenAtStart: (string | undefined)[] = [];

    const runBatches = vi
      .fn()
      .mockImplementation(
        async (
          _tasks: TasksMap,
          _ctx: Record<string, CtxEntry>,
          sm?: SessionManager,
        ) => {
          // Record the handle visible at the start of this iteration
          handlesSeenAtStart.push(sm?.getHandleByToken("loop-session"));
          // Simulate: inner task produces a session handle
          sm?.setHandle("fix", `handle-iter-${iteration}`);
          iteration++;
          return {
            fix: { output: { done: iteration >= 2 }, _source: "agent" },
          };
        },
      );

    const executor = new LoopExecutor(runBatches as RunBatchesFn);
    const loopDef = makeLoopDef({
      context: undefined, // default = "fresh"
      until: (ctx) => {
        const c = ctx as Record<string, CtxEntry>;
        return (c.fix?.output as { done: boolean } | undefined)?.done === true;
      },
      tasks: innerTasks,
      max: 5,
    });

    await executor.run(loopDef, {}, "fresh-loop");

    expect(runBatches).toHaveBeenCalledTimes(2);
    // Each iteration gets a new SM — no handles bleed across iterations
    expect(handlesSeenAtStart[0]).toBeUndefined(); // iteration 0: fresh, no prior handle
    expect(handlesSeenAtStart[1]).toBeUndefined(); // iteration 1: fresh, no prior handle
  });

  it("context: 'persistent' — second iteration receives handles from first", async () => {
    // With context: "persistent", one SessionManager lives across all iterations.
    // runBatches receives the same SM instance each time; handles accumulate.
    const tok = sessionToken("persist-session", "claude");
    const innerTasks: TasksMap = {
      fix: { agent: dummyAgent, session: tok },
    };

    let iteration = 0;
    const handlesSeenAtStart: (string | undefined)[] = [];

    const runBatches = vi
      .fn()
      .mockImplementation(
        async (
          _tasks: TasksMap,
          _ctx: Record<string, CtxEntry>,
          sm?: SessionManager,
        ) => {
          // Record handle visible at start of this iteration
          handlesSeenAtStart.push(sm?.getHandleByToken("persist-session"));
          // Simulate: inner task produces a session handle
          sm?.setHandle("fix", `handle-iter-${iteration}`);
          iteration++;
          return {
            fix: { output: { done: iteration >= 2 }, _source: "agent" },
          };
        },
      );

    const executor = new LoopExecutor(runBatches as RunBatchesFn);
    const loopDef = makeLoopDef({
      context: "persistent",
      until: (ctx) => {
        const c = ctx as Record<string, CtxEntry>;
        return (c.fix?.output as { done: boolean } | undefined)?.done === true;
      },
      tasks: innerTasks,
      max: 5,
    });

    await executor.run(loopDef, {}, "persist-loop");

    expect(runBatches).toHaveBeenCalledTimes(2);
    // Iteration 0: no prior handle
    expect(handlesSeenAtStart[0]).toBeUndefined();
    // Iteration 1: receives handle produced by iteration 0
    expect(handlesSeenAtStart[1]).toBe("handle-iter-0");
  });

  it("returns output of the final iteration", async () => {
    const expectedOutput = {
      task1: { output: { done: true, value: 42 }, _source: "agent" },
    };
    const runBatches = vi.fn().mockResolvedValue(expectedOutput);
    const executor = new LoopExecutor(runBatches as RunBatchesFn);

    const result = await executor.run(
      makeLoopDef({ until: () => true }),
      {},
      "result-loop",
    );
    expect(result).toEqual(expectedOutput);
  });
});
