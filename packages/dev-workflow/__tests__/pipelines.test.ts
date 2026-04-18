// Smoke tests for the pipeline factories — confirms that `feature`, `bugfix`,
// and `docs` build valid DAGs at definition time with the role prompts
// loaded from disk.

import { describe, expect, it } from "vitest";
import { createBugfixPipeline } from "../pipelines/bugfix.js";
import { createDocsPipeline } from "../pipelines/docs.js";
import { createFeaturePipeline } from "../pipelines/feature.js";
import type { WorkflowInput } from "../shared/types.js";

const FAKE_INPUT: WorkflowInput = {
  issue: {
    number: 1,
    title: "example",
    body: "example body @ageflow/core mentions",
    labels: ["bug", "high"],
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
  it("builds a workflow named bugfix-pipeline with 6 tasks", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    expect(wf.name).toBe("bugfix-pipeline");
    const keys = Object.keys(wf.tasks).sort();
    expect(keys).toEqual([
      "fix",
      "reproduce",
      "ship",
      "test",
      "triage",
      "verify",
    ]);
  });

  it("triage task is a defineFunction (label classifier)", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const triage = wf.tasks.triage as { agent?: unknown; fn?: unknown };
    expect(triage.fn).toBeDefined();
    expect(triage.agent).toBeUndefined();
  });

  it("reproduce task is an agent (senior-developer role-backed)", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const reproduce = wf.tasks.reproduce as { agent?: unknown; fn?: unknown };
    expect(reproduce.agent).toBeDefined();
    expect(reproduce.fn).toBeUndefined();
  });

  it("fix task is an agent (senior-developer role-backed)", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const fix = wf.tasks.fix as { agent?: unknown; fn?: unknown };
    expect(fix.agent).toBeDefined();
    expect(fix.fn).toBeUndefined();
  });

  it("test task is a defineFunction (bun test runner)", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const test = wf.tasks.test as { agent?: unknown; fn?: unknown };
    expect(test.fn).toBeDefined();
    expect(test.agent).toBeUndefined();
  });

  it("verify task is an agent (reality-checker role-backed)", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const verify = wf.tasks.verify as { agent?: unknown; fn?: unknown };
    expect(verify.agent).toBeDefined();
    expect(verify.fn).toBeUndefined();
  });

  it("ship task is a defineFunction (git + gh pr create)", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const ship = wf.tasks.ship as { agent?: unknown; fn?: unknown };
    expect(ship.fn).toBeDefined();
    expect(ship.agent).toBeUndefined();
  });

  it("reproduce dependsOn triage", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const reproduce = wf.tasks.reproduce as { dependsOn?: readonly string[] };
    expect(reproduce.dependsOn).toContain("triage");
  });

  it("fix dependsOn reproduce", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const fix = wf.tasks.fix as { dependsOn?: readonly string[] };
    expect(fix.dependsOn).toContain("reproduce");
  });

  it("test dependsOn fix", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const test = wf.tasks.test as { dependsOn?: readonly string[] };
    expect(test.dependsOn).toContain("fix");
  });

  it("verify dependsOn test", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const verify = wf.tasks.verify as { dependsOn?: readonly string[] };
    expect(verify.dependsOn).toContain("test");
  });

  it("ship dependsOn verify and fix", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const ship = wf.tasks.ship as { dependsOn?: readonly string[] };
    expect(ship.dependsOn).toContain("verify");
    expect(ship.dependsOn).toContain("fix");
  });

  it("reproduce and fix share a session token", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const reproduce = wf.tasks.reproduce as {
      session?: { kind: string; name: string };
    };
    const fix = wf.tasks.fix as { session?: { kind: string; name: string } };
    expect(reproduce.session).toBeDefined();
    expect(fix.session).toBeDefined();
    expect(reproduce.session?.kind).toBe("token");
    expect(fix.session?.kind).toBe("token");
    expect(reproduce.session?.name).toBe(fix.session?.name);
  });

  it("triage has no session (deterministic fn)", () => {
    const wf = createBugfixPipeline(FAKE_INPUT);
    const triage = wf.tasks.triage as { session?: unknown };
    expect(triage.session).toBeUndefined();
  });
});

describe("docs pipeline", () => {
  it("builds a workflow named docs-pipeline with 3 tasks", () => {
    const wf = createDocsPipeline(FAKE_INPUT);
    expect(wf.name).toBe("docs-pipeline");
    const keys = Object.keys(wf.tasks).sort();
    expect(keys).toEqual(["draft", "publish", "review"]);
  });

  it("draft task is an agent (technical-writer role-backed)", () => {
    const wf = createDocsPipeline(FAKE_INPUT);
    const draft = wf.tasks.draft as { agent?: unknown; fn?: unknown };
    expect(draft.agent).toBeDefined();
    expect(draft.fn).toBeUndefined();
  });

  it("review task is an agent (code-reviewer role-backed)", () => {
    const wf = createDocsPipeline(FAKE_INPUT);
    const review = wf.tasks.review as { agent?: unknown; fn?: unknown };
    expect(review.agent).toBeDefined();
    expect(review.fn).toBeUndefined();
  });

  it("publish task is a defineFunction (deterministic git+gh)", () => {
    const wf = createDocsPipeline(FAKE_INPUT);
    const publish = wf.tasks.publish as { agent?: unknown; fn?: unknown };
    expect(publish.fn).toBeDefined();
    expect(publish.agent).toBeUndefined();
  });

  it("review dependsOn draft", () => {
    const wf = createDocsPipeline(FAKE_INPUT);
    const review = wf.tasks.review as { dependsOn?: readonly string[] };
    expect(review.dependsOn).toContain("draft");
  });

  it("publish dependsOn both draft and review", () => {
    const wf = createDocsPipeline(FAKE_INPUT);
    const publish = wf.tasks.publish as { dependsOn?: readonly string[] };
    expect(publish.dependsOn).toContain("draft");
    expect(publish.dependsOn).toContain("review");
  });
});
