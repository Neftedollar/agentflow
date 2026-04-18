// Smoke tests for the pipeline factories — confirms that `feature`, `bugfix`,
// `docs`, and `release` build valid DAGs at definition time.

import { describe, expect, it, vi } from "vitest";
import { createBugfixPipeline } from "../pipelines/bugfix.js";
import { createDocsPipeline } from "../pipelines/docs.js";
import { createFeaturePipeline } from "../pipelines/feature.js";
import {
  PUBLISH_ORDER,
  bumpFn,
  createReleasePipeline,
  publishFn,
  semverBump,
} from "../pipelines/release.js";
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

  it("build task is an agent (senior-developer role-backed)", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    const build = wf.tasks.build as { agent?: unknown; fn?: unknown };
    expect(build.agent).toBeDefined();
    expect(build.fn).toBeUndefined();
  });

  it("test task is a defineFunction (deterministic bun test runner)", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    const test = wf.tasks.test as { agent?: unknown; fn?: unknown };
    expect(test.fn).toBeDefined();
    expect(test.agent).toBeUndefined();
  });

  it("ship task is a defineFunction (deterministic git+gh)", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    const ship = wf.tasks.ship as { agent?: unknown; fn?: unknown };
    expect(ship.fn).toBeDefined();
    expect(ship.agent).toBeUndefined();
  });

  it("build dependsOn plan", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    const build = wf.tasks.build as { dependsOn?: readonly string[] };
    expect(build.dependsOn).toContain("plan");
  });

  it("test dependsOn build", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    const test = wf.tasks.test as { dependsOn?: readonly string[] };
    expect(test.dependsOn).toContain("build");
  });

  it("verify dependsOn test and plan", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    const verify = wf.tasks.verify as { dependsOn?: readonly string[] };
    expect(verify.dependsOn).toContain("test");
    expect(verify.dependsOn).toContain("plan");
  });

  it("ship dependsOn verify and build", () => {
    const wf = createFeaturePipeline(FAKE_INPUT);
    const ship = wf.tasks.ship as { dependsOn?: readonly string[] };
    expect(ship.dependsOn).toContain("verify");
    expect(ship.dependsOn).toContain("build");
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

describe("release pipeline", () => {
  it("builds a workflow named release-pipeline with 4 tasks", () => {
    const wf = createReleasePipeline(FAKE_INPUT);
    expect(wf.name).toBe("release-pipeline");
    const keys = Object.keys(wf.tasks).sort();
    expect(keys).toEqual(["bump", "changelog", "cleanup", "publish"]);
  });

  it("all 4 tasks are defineFunction (fn), not agent", () => {
    const wf = createReleasePipeline(FAKE_INPUT);
    for (const key of ["bump", "changelog", "publish", "cleanup"] as const) {
      const task = wf.tasks[key] as { agent?: unknown; fn?: unknown };
      expect(task.fn).toBeDefined();
      expect(task.agent).toBeUndefined();
    }
  });

  it("bump has no dependsOn", () => {
    const wf = createReleasePipeline(FAKE_INPUT);
    const bump = wf.tasks.bump as { dependsOn?: readonly string[] };
    expect(bump.dependsOn).toBeUndefined();
  });

  it("changelog dependsOn bump", () => {
    const wf = createReleasePipeline(FAKE_INPUT);
    const changelog = wf.tasks.changelog as { dependsOn?: readonly string[] };
    expect(changelog.dependsOn).toContain("bump");
  });

  it("publish dependsOn changelog and bump", () => {
    const wf = createReleasePipeline(FAKE_INPUT);
    const publish = wf.tasks.publish as { dependsOn?: readonly string[] };
    expect(publish.dependsOn).toContain("changelog");
    expect(publish.dependsOn).toContain("bump");
  });

  it("cleanup dependsOn publish and bump", () => {
    const wf = createReleasePipeline(FAKE_INPUT);
    const cleanup = wf.tasks.cleanup as { dependsOn?: readonly string[] };
    expect(cleanup.dependsOn).toContain("publish");
    expect(cleanup.dependsOn).toContain("bump");
  });
});

describe("bumpFn.execute — P1-1 guard", () => {
  it("throws when affectedPackages is empty", async () => {
    await expect(
      bumpFn.execute({
        issueNumber: 1,
        labels: ["patch"],
        issueBody: "no package references here",
        worktreePath: "/tmp/fake-wt",
        affectedPackages: [],
      }),
    ).rejects.toThrow("affectedPackages is empty");
  });

  it("does not throw when affectedPackages has at least one entry", async () => {
    // The package dir won't exist on disk, so bumps will be empty but no throw.
    const result = await bumpFn.execute({
      issueNumber: 1,
      labels: ["patch"],
      issueBody: "@ageflow/core",
      worktreePath: "/tmp/fake-wt-nonexistent",
      affectedPackages: ["@ageflow/core"],
    });
    // No throw — bumps empty because dir doesn't exist, bumpKind defaults patch.
    expect(result.bumpKind).toBe("patch");
    expect(result.bumps).toEqual([]);
  });
});

describe("publishFn.execute — P1-3 throw on failure", () => {
  it("throws when any npm publish fails (skipped.length > 0)", async () => {
    // Mock execa to reject for @ageflow/core, succeed for nothing else.
    vi.mock("execa", () => ({
      execa: vi
        .fn()
        .mockRejectedValue(new Error("E403 Forbidden — auth required")),
    }));

    await expect(
      publishFn.execute({
        bumps: [{ package: "@ageflow/core", before: "0.6.0", after: "0.6.1" }],
        worktreePath: "/tmp/fake-wt-nonexistent",
        plan: false,
      }),
    ).rejects.toThrow("publish failed for");

    vi.restoreAllMocks();
  });

  it("does not throw in plan:true mode (dry-run — no real publish)", async () => {
    // plan:true path never calls execa, so no failures.
    const result = await publishFn.execute({
      bumps: [{ package: "@ageflow/core", before: "0.6.0", after: "0.6.1" }],
      worktreePath: "/tmp/fake-wt-nonexistent",
      plan: true,
    });
    expect(result.published).toContain("@ageflow/core");
    expect(result.skipped).toHaveLength(0);
  });
});

describe("PUBLISH_ORDER — P1-2 runner-anthropic included", () => {
  it("contains @ageflow/runner-anthropic", () => {
    expect(PUBLISH_ORDER).toContain("@ageflow/runner-anthropic");
  });

  it("@ageflow/runner-anthropic appears after @ageflow/runner-api", () => {
    const apiIdx = PUBLISH_ORDER.indexOf("@ageflow/runner-api");
    const anthropicIdx = PUBLISH_ORDER.indexOf("@ageflow/runner-anthropic");
    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(anthropicIdx).toBeGreaterThan(apiIdx);
  });

  it("@ageflow/runner-anthropic appears before @ageflow/testing", () => {
    const anthropicIdx = PUBLISH_ORDER.indexOf("@ageflow/runner-anthropic");
    const testingIdx = PUBLISH_ORDER.indexOf("@ageflow/testing");
    expect(anthropicIdx).toBeLessThan(testingIdx);
  });
});

describe("semverBump", () => {
  it("patch: increments patch, leaves major/minor", () => {
    expect(semverBump("1.2.3", "patch")).toBe("1.2.4");
    expect(semverBump("0.0.0", "patch")).toBe("0.0.1");
    expect(semverBump("1.0.0", "patch")).toBe("1.0.1");
  });

  it("minor: increments minor, resets patch", () => {
    expect(semverBump("1.2.3", "minor")).toBe("1.3.0");
    expect(semverBump("0.5.9", "minor")).toBe("0.6.0");
    expect(semverBump("2.0.0", "minor")).toBe("2.1.0");
  });

  it("major: increments major, resets minor + patch", () => {
    expect(semverBump("1.2.3", "major")).toBe("2.0.0");
    expect(semverBump("0.9.9", "major")).toBe("1.0.0");
    expect(semverBump("3.4.5", "major")).toBe("4.0.0");
  });

  it("throws on invalid semver string", () => {
    expect(() => semverBump("not-a-version", "patch")).toThrow(
      "invalid semver",
    );
  });
});
