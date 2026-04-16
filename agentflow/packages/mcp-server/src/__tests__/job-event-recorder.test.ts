import { describe, expect, it } from "vitest";
import { JobEventRecorder } from "../job-event-recorder.js";
import type {
  BudgetWarningEvent,
  TaskCompleteEvent,
  TaskStartEvent,
} from "@ageflow/core";

const baseEv = {
  runId: "r1",
  workflowName: "wf",
  timestamp: 0,
};

describe("JobEventRecorder", () => {
  it("tracks lastTaskStart, tasksCompleted, lastBudgetWarning per runId", () => {
    const rec = new JobEventRecorder();
    rec.record({ ...baseEv, type: "task:start", taskName: "a" } as TaskStartEvent);
    expect(rec.snapshot("r1")).toMatchObject({
      tasksCompleted: 0,
      lastTaskStart: { taskName: "a" },
    });

    rec.record({
      ...baseEv,
      type: "task:complete",
      taskName: "a",
      output: {},
      metrics: { latencyMs: 0, tokensIn: 0, tokensOut: 0, estimatedCost: 0 },
    } as TaskCompleteEvent);
    expect(rec.snapshot("r1")?.tasksCompleted).toBe(1);

    rec.record({
      ...baseEv,
      type: "budget:warning",
      spentUsd: 0.5,
      limitUsd: 1.0,
    } as BudgetWarningEvent);
    expect(rec.snapshot("r1")?.lastBudgetWarning).toEqual({
      spentUsd: 0.5,
      limitUsd: 1.0,
      at: 0,
    });
  });

  it("isolates state between runIds", () => {
    const rec = new JobEventRecorder();
    rec.record({ ...baseEv, runId: "a", type: "task:start", taskName: "x" } as TaskStartEvent);
    rec.record({ ...baseEv, runId: "b", type: "task:start", taskName: "y" } as TaskStartEvent);
    expect(rec.snapshot("a")?.lastTaskStart?.taskName).toBe("x");
    expect(rec.snapshot("b")?.lastTaskStart?.taskName).toBe("y");
  });

  it("returns undefined for unknown runId", () => {
    const rec = new JobEventRecorder();
    expect(rec.snapshot("ghost")).toBeUndefined();
  });

  it("drops state on forget(runId)", () => {
    const rec = new JobEventRecorder();
    rec.record({ ...baseEv, type: "task:start", taskName: "a" } as TaskStartEvent);
    expect(rec.snapshot("r1")).toBeDefined();
    rec.forget("r1");
    expect(rec.snapshot("r1")).toBeUndefined();
  });
});
