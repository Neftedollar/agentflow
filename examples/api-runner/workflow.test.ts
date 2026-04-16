/**
 * workflow.test.ts — Harness-based test for the api-runner example workflow.
 *
 * Uses @ageflow/testing to mock the agent — no real API calls made.
 */

import { createTestHarness } from "@ageflow/testing";
import { describe, expect, it } from "vitest";
import { workflow } from "./workflow.js";

describe("api-runner demo workflow", () => {
  it("produces a summary via mock agent", async () => {
    const harness = createTestHarness(workflow);
    harness.mockAgent("summarize", {
      summary: "AgentFlow ships the api runner.",
    });
    const res = await harness.run({});
    const summary = (res.outputs.summarize as { summary: string }).summary;
    expect(summary.toLowerCase()).toContain("api runner");
  });

  it("records call stats for the summarize task", async () => {
    const harness = createTestHarness(workflow);
    harness.mockAgent("summarize", { summary: "demo summary for stats" });
    await harness.run({});
    const stats = harness.getTask("summarize");
    expect(stats.callCount).toBe(1);
    expect(stats.retryCount).toBe(0);
    expect(stats.outputs).toHaveLength(1);
  });
});
