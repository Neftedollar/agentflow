import type { TaskMetrics, WorkflowEvent } from "@ageflow/core";
import type { WorkflowExecutor } from "@ageflow/executor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderEvent, runWithProgress } from "../run.js";
import type { WorkflowInput } from "../shared/types.js";

vi.mock("../shared/learning.js", () => ({
  initLearning: () => ({
    hooks: {},
    store: { close: () => {} },
    dbPath: "/tmp/learning.sqlite",
  }),
}));

function taskMetrics(estimatedCost: number, latencyMs: number): TaskMetrics {
  return {
    tokensIn: 0,
    tokensOut: 0,
    latencyMs,
    retries: 0,
    estimatedCost,
  };
}

const baseEvent = {
  runId: "run-1",
  workflowName: "feature-pipeline",
} as const;

const fakeInput: WorkflowInput = {
  issue: {
    number: 234,
    title: "progress smoke",
    labels: ["feature"],
    state: "open",
    url: "https://example.com/issues/234",
  },
  worktreePath: "/tmp/agents-workflow-wt-234",
  specPath: "/tmp/spec.md",
  dryRun: false,
};

describe("renderEvent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prints task start and complete progress, including budget progress", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const state = {
      starts: new Map<string, number>(),
      spentUsd: 0,
      warned80: false,
    };

    const startEv: WorkflowEvent = {
      ...baseEvent,
      type: "task:start",
      taskName: "build",
      timestamp: 1_000,
    };
    const completeEv: WorkflowEvent = {
      ...baseEvent,
      type: "task:complete",
      taskName: "build",
      output: { ok: true },
      metrics: taskMetrics(0.25, 999),
      timestamp: 2_500,
    };

    renderEvent(startEv, 1, state);
    renderEvent(completeEv, 1, state);

    expect(state.spentUsd).toBeCloseTo(0.25);
    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("build started"))).toBe(true);
    expect(lines.some((line) => line.includes("build completed in 1.5s"))).toBe(
      true,
    );
    expect(
      lines.some((line) => line.includes("$0.2500 / $1.0000 (25.0%)")),
    ).toBe(true);
  });

  it("emits the 80% warning once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const state = {
      starts: new Map<string, number>(),
      spentUsd: 0,
      warned80: false,
    };

    const completeA: WorkflowEvent = {
      ...baseEvent,
      type: "task:complete",
      taskName: "plan",
      output: "ok",
      metrics: taskMetrics(0.4, 100),
      timestamp: 10,
    };
    const completeB: WorkflowEvent = {
      ...baseEvent,
      type: "task:complete",
      taskName: "build",
      output: "ok",
      metrics: taskMetrics(0.4, 100),
      timestamp: 20,
    };
    const completeC: WorkflowEvent = {
      ...baseEvent,
      type: "task:complete",
      taskName: "test",
      output: "ok",
      metrics: taskMetrics(0.4, 100),
      timestamp: 30,
    };

    renderEvent(completeA, 1, state);
    renderEvent(completeB, 1, state);
    renderEvent(completeC, 1, state);

    expect(state.warned80).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "reached 80.0% of cap",
    );
  });

  it("prints unlimited-budget line when budget cap is not set", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const state = {
      starts: new Map<string, number>(),
      spentUsd: 0,
      warned80: false,
    };

    const completeEv: WorkflowEvent = {
      ...baseEvent,
      type: "task:complete",
      taskName: "verify",
      output: "ok",
      metrics: taskMetrics(0.1, 100),
      timestamp: 10,
    };

    renderEvent(completeEv, undefined, state);

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("(no cap)"))).toBe(true);
  });

  it("prints task error with duration when a start timestamp exists", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const state = {
      starts: new Map<string, number>(),
      spentUsd: 0,
      warned80: false,
    };

    const startEv: WorkflowEvent = {
      ...baseEvent,
      type: "task:start",
      taskName: "ship",
      timestamp: 2_000,
    };
    const errorEv: WorkflowEvent = {
      ...baseEvent,
      type: "task:error",
      taskName: "ship",
      error: { name: "Error", message: "push failed" },
      attempt: 1,
      terminal: true,
      timestamp: 7_000,
    };

    renderEvent(startEv, 1, state);
    renderEvent(errorEv, 1, state);

    expect(String(errorSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "ship failed after 5.0s: push failed",
    );
  });
});

describe("runWithProgress", () => {
  it("drains stream events and returns generator done value", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const events: WorkflowEvent[] = [
      {
        ...baseEvent,
        type: "task:start",
        taskName: "plan",
        timestamp: 1,
      },
      {
        ...baseEvent,
        type: "task:complete",
        taskName: "plan",
        output: { ok: true },
        metrics: taskMetrics(0.05, 100),
        timestamp: 101,
      },
      {
        ...baseEvent,
        type: "task:error",
        taskName: "build",
        error: { name: "Error", message: "lint failed" },
        attempt: 1,
        terminal: true,
        timestamp: 202,
      },
    ];

    const doneValue = {
      outputs: { plan: { ok: true } },
      metrics: { totalEstimatedCost: 0.05 },
    };

    const fakeExecutor = {
      async *stream() {
        for (const ev of events) {
          yield ev;
        }
        return doneValue;
      },
    } as unknown as WorkflowExecutor<Record<string, never>>;

    const result = await runWithProgress(fakeExecutor, fakeInput, 5);
    expect(result).toEqual(doneValue);
  });
});
