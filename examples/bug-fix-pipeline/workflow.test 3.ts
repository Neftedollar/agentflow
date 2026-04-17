import type { WorkflowDef } from "@ageflow/core";
import { createTestHarness } from "@ageflow/testing";
import { describe, expect, it } from "vitest";
import workflow from "./workflow.js";

/**
 * Wrap workflow with an auto-approving checkpoint hook for headless test environments.
 * In production, the checkpoint waits for TTY input or a hook that returns Promise<true>.
 * Cast to WorkflowDef to widen the hooks type for createTestHarness compatibility.
 */
const workflowForTest: WorkflowDef = {
  ...(workflow as WorkflowDef),
  hooks: {
    onCheckpoint: (_taskName: string, _message: string) =>
      Promise.resolve(true) as Promise<boolean>,
  },
};

describe("bug-fix-pipeline", () => {
  it("runs full pipeline: analyze → fix+eval loop → summarize", async () => {
    const harness = createTestHarness(workflowForTest);

    harness.mockAgent("analyze", {
      issues: [
        {
          id: "i1",
          file: "src/app.ts",
          description: "Null pointer dereference",
          severity: "high",
        },
      ],
      summary: "Found 1 critical issue",
    });

    harness.mockAgent("fix", {
      patch: "diff --git a/src/app.ts\n-  obj.method()\n+  obj?.method()",
      explanation: "Added optional chaining to prevent null dereference",
      confidence: 0.9,
    });

    harness.mockAgent("eval", {
      satisfied: true,
      feedback: "Fix looks correct",
      score: 8,
    });

    harness.mockAgent("summarize", {
      report: "Fixed 1 critical issue: null pointer dereference in src/app.ts",
      fixedCount: 1,
      remainingCount: 0,
    });

    const result = await harness.run();

    // Workflow completed
    expect(result.outputs.summarize).toMatchObject({
      report: expect.stringContaining("Fixed 1 critical issue"),
      fixedCount: 1,
      remainingCount: 0,
    });

    // Analyze ran once
    const analyzeStats = harness.getTask("analyze");
    expect(analyzeStats.callCount).toBe(1);

    // Fix ran once (eval was satisfied on first try)
    const fixStats = harness.getTask("fix");
    expect(fixStats.callCount).toBe(1);
  });

  it("retries fix loop when eval is not satisfied", async () => {
    const harness = createTestHarness(workflowForTest);

    harness.mockAgent("analyze", {
      issues: [
        {
          id: "i1",
          file: "src/app.ts",
          description: "Memory leak",
          severity: "high",
        },
      ],
      summary: "Found 1 issue",
    });

    // First eval: not satisfied, second: satisfied
    harness.mockAgent("eval", [
      { satisfied: false, feedback: "The fix is incomplete", score: 3 },
      { satisfied: true, feedback: "Now it looks correct", score: 8 },
    ]);

    harness.mockAgent("fix", [
      { patch: "- bad fix", explanation: "First attempt", confidence: 0.4 },
      {
        patch: "+ correct fix",
        explanation: "Second attempt",
        confidence: 0.9,
      },
    ]);

    harness.mockAgent("summarize", {
      report: "Fixed 1 issue after 2 iterations",
      fixedCount: 1,
      remainingCount: 0,
    });

    const result = await harness.run();

    expect(result.outputs.summarize).toBeDefined();

    // Fix ran twice (loop needed 2 iterations)
    const fixStats = harness.getTask("fix");
    expect(fixStats.callCount).toBe(2);

    const evalStats = harness.getTask("eval");
    expect(evalStats.callCount).toBe(2);
  });

  it("workflow metrics are populated", async () => {
    const harness = createTestHarness(workflowForTest);

    harness.mockAgent("analyze", {
      issues: [],
      summary: "No issues found",
    });
    harness.mockAgent("fix", {
      patch: "",
      explanation: "nothing to fix",
      confidence: 1.0,
    });
    harness.mockAgent("eval", { satisfied: true, feedback: "ok", score: 10 });
    harness.mockAgent("summarize", {
      report: "Clean codebase",
      fixedCount: 0,
      remainingCount: 0,
    });

    const result = await harness.run();

    expect(result.metrics.taskCount).toBeGreaterThan(0);
    expect(result.metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
