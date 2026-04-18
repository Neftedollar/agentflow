// Smoke tests for the pipeline factories — confirms both `feature` and
// `bugfix` build a valid DAG at definition time with the role prompts
// loaded from disk.

import { describe, expect, it } from "vitest";
import { createBugfixPipeline } from "../pipelines/bugfix.js";
import { createFeaturePipeline } from "../pipelines/feature.js";
import type { WorkflowInput } from "../shared/types.js";

const FAKE_INPUT: WorkflowInput = {
  issue: {
    number: 1,
    title: "example",
    body: "example body",
    labels: [],
    state: "open",
    url: "https://github.com/example/repo/issues/1",
  },
  worktreePath: "/tmp/example-wt",
  specPath: "/tmp/spec.md",
  dryRun: true,
};

describe("feature pipeline", () => {
  it("builds a workflow with both agent and function tasks", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    expect(wf.name).toBe("feature-pipeline");
    const keys = Object.keys(wf.tasks).sort();
    expect(keys).toEqual(["build", "plan", "ship", "test", "verify"]);
  });

  it("plan task is an agent (role-backed)", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    const plan = wf.tasks.plan as { agent?: unknown; fn?: unknown };
    expect(plan.agent).toBeDefined();
    expect(plan.fn).toBeUndefined();
  });

  it("verify task is an agent (role-backed)", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    const verify = wf.tasks.verify as { agent?: unknown; fn?: unknown };
    expect(verify.agent).toBeDefined();
  });

  it("build/test/ship remain defineFunction stubs (mixed-node pattern)", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    for (const key of ["build", "test", "ship"] as const) {
      const task = wf.tasks[key] as { agent?: unknown; fn?: unknown };
      expect(task.fn).toBeDefined();
      expect(task.agent).toBeUndefined();
    }
  });
});

describe("bugfix pipeline", () => {
  it("builds a workflow with the reality-checker at VERIFY", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    expect(wf.name).toBe("bugfix-pipeline");
    const verify = wf.tasks.verify as { agent?: unknown; fn?: unknown };
    expect(verify.agent).toBeDefined();
  });

  it("triage/reproduce/fix/test/ship remain stubs", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    for (const key of ["triage", "reproduce", "fix", "test", "ship"] as const) {
      const task = wf.tasks[key] as { agent?: unknown; fn?: unknown };
      expect(task.fn).toBeDefined();
      expect(task.agent).toBeUndefined();
    }
  });
});
