import { defineAgent, defineWorkflow } from "@agentflow/core";
import type { TasksMap } from "@agentflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getReadyTasks, topologicalSort } from "../dag-resolver.js";
import { CyclicDependencyError, UnresolvedDependencyError } from "../errors.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const dummyAgent = defineAgent({
  runner: "mock",
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  prompt: () => "test",
});

function makeTask(dependsOn?: string[]) {
  return {
    agent: dummyAgent,
    dependsOn,
  };
}

// ─── topologicalSort tests ────────────────────────────────────────────────────

describe("topologicalSort", () => {
  it("sorts a linear chain A→B→C correctly", () => {
    const tasks: TasksMap = {
      A: makeTask([]),
      B: makeTask(["A"]),
      C: makeTask(["B"]),
    };

    const batches = topologicalSort(tasks);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual(["A"]);
    expect(batches[1]).toEqual(["B"]);
    expect(batches[2]).toEqual(["C"]);
  });

  it("puts B and C in the same batch for diamond A→{B,C}→D", () => {
    const tasks: TasksMap = {
      A: makeTask([]),
      B: makeTask(["A"]),
      C: makeTask(["A"]),
      D: makeTask(["B", "C"]),
    };

    const batches = topologicalSort(tasks);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toEqual(["A"]);
    // B and C can be in either order in the second batch
    expect(batches[1]).toHaveLength(2);
    expect(batches[1]).toContain("B");
    expect(batches[1]).toContain("C");
    expect(batches[2]).toEqual(["D"]);
  });

  it("puts all disconnected tasks (no deps) in first batch", () => {
    const tasks: TasksMap = {
      A: makeTask([]),
      B: makeTask([]),
      C: makeTask([]),
    };

    const batches = topologicalSort(tasks);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]).toContain("A");
    expect(batches[0]).toContain("B");
    expect(batches[0]).toContain("C");
  });

  it("returns single batch with single task and no deps", () => {
    const tasks: TasksMap = {
      A: makeTask(),
    };

    const batches = topologicalSort(tasks);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(["A"]);
  });

  it("returns empty array for empty tasks map", () => {
    const batches = topologicalSort({});
    expect(batches).toEqual([]);
  });

  it("throws CyclicDependencyError for A→B→A cycle", () => {
    const tasks: TasksMap = {
      A: makeTask(["B"]),
      B: makeTask(["A"]),
    };

    expect(() => topologicalSort(tasks)).toThrow(CyclicDependencyError);
  });

  it("throws CyclicDependencyError for self-loop A→A", () => {
    const tasks: TasksMap = {
      A: makeTask(["A"]),
    };

    expect(() => topologicalSort(tasks)).toThrow(CyclicDependencyError);
  });

  it("throws CyclicDependencyError for three-node cycle A→B→C→A", () => {
    const tasks: TasksMap = {
      A: makeTask(["C"]),
      B: makeTask(["A"]),
      C: makeTask(["B"]),
    };

    expect(() => topologicalSort(tasks)).toThrow(CyclicDependencyError);
  });

  it("includes cycle path in CyclicDependencyError", () => {
    const tasks: TasksMap = {
      A: makeTask(["B"]),
      B: makeTask(["A"]),
    };

    let caught: CyclicDependencyError | undefined;
    try {
      topologicalSort(tasks);
    } catch (e) {
      if (e instanceof CyclicDependencyError) {
        caught = e;
      }
    }

    expect(caught).toBeInstanceOf(CyclicDependencyError);
    expect(caught?.cycle).toBeDefined();
    expect(caught?.cycle.length).toBeGreaterThan(0);
  });

  it("handles tasks with no dependsOn property (undefined)", () => {
    const tasks: TasksMap = {
      A: { agent: dummyAgent },
      B: { agent: dummyAgent, dependsOn: ["A"] },
    };

    const batches = topologicalSort(tasks);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(["A"]);
    expect(batches[1]).toEqual(["B"]);
  });

  it("uses defineWorkflow tasks correctly", () => {
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        fetch: makeTask([]),
        process: makeTask(["fetch"]),
        report: makeTask(["process"]),
      },
    });

    const batches = topologicalSort(workflow.tasks);
    expect(batches).toHaveLength(3);
  });

  it("throws UnresolvedDependencyError for unknown dependency name", () => {
    const tasks: TasksMap = {
      A: makeTask(["nonexistent"]),
    };

    expect(() => topologicalSort(tasks)).toThrow(UnresolvedDependencyError);
  });

  it("UnresolvedDependencyError contains task and dep names", () => {
    const tasks: TasksMap = {
      myTask: makeTask(["ghost"]),
    };

    let caught: UnresolvedDependencyError | undefined;
    try {
      topologicalSort(tasks);
    } catch (e) {
      if (e instanceof UnresolvedDependencyError) {
        caught = e;
      }
    }

    expect(caught).toBeInstanceOf(UnresolvedDependencyError);
    expect(caught?.taskName).toBe("myTask");
    expect(caught?.depName).toBe("ghost");
  });
});

// ─── getReadyTasks tests ──────────────────────────────────────────────────────

describe("getReadyTasks", () => {
  it("returns all tasks with no deps when nothing completed", () => {
    const tasks: TasksMap = {
      A: makeTask([]),
      B: makeTask([]),
    };

    const ready = getReadyTasks(new Set(), tasks);
    expect(ready).toHaveLength(2);
    expect(ready).toContain("A");
    expect(ready).toContain("B");
  });

  it("returns dependent task once its dep is completed", () => {
    const tasks: TasksMap = {
      A: makeTask([]),
      B: makeTask(["A"]),
    };

    const ready = getReadyTasks(new Set(["A"]), tasks);
    expect(ready).toEqual(["B"]);
  });

  it("returns empty array when all tasks are completed", () => {
    const tasks: TasksMap = {
      A: makeTask([]),
      B: makeTask(["A"]),
    };

    const ready = getReadyTasks(new Set(["A", "B"]), tasks);
    expect(ready).toEqual([]);
  });

  it("only returns task B when both deps A and C are complete (not just one)", () => {
    const tasks: TasksMap = {
      A: makeTask([]),
      C: makeTask([]),
      B: makeTask(["A", "C"]),
    };

    // Only A is done — B should NOT be ready
    const readyPartial = getReadyTasks(new Set(["A"]), tasks);
    expect(readyPartial).not.toContain("B");
    expect(readyPartial).toContain("C");

    // Both A and C done — B should be ready
    const readyFull = getReadyTasks(new Set(["A", "C"]), tasks);
    expect(readyFull).toContain("B");
  });

  it("excludes already-completed tasks from the result", () => {
    const tasks: TasksMap = {
      A: makeTask([]),
      B: makeTask(["A"]),
    };

    const ready = getReadyTasks(new Set(["A"]), tasks);
    expect(ready).not.toContain("A");
  });
});
