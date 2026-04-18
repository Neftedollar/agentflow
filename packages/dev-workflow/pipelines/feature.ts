// Feature pipeline — PLAN → BUILD → TEST → VERIFY → SHIP DAG.
//
// PR C: build, test, and ship are now real implementations:
//   plan   — defineAgent using engineering-software-architect role (codex) ✅
//   build  — defineAgent using engineering-senior-developer role (codex)
//   test   — defineFunction spawning `bun test` with 10-min timeout
//   verify — defineAgent using engineering-code-reviewer role (codex) ✅
//   ship   — defineFunction — git add/commit/push + gh pr create
//
// Session on build is deferred to PR D where fix→test iteration needs it.

import {
  defineAgent,
  defineFunction,
  defineWorkflowFactory,
} from "@ageflow/core";
import { execa } from "execa";
import { z } from "zod";
import { loadRoleSync } from "../shared/role-loader.js";
import type { WorkflowInput } from "../shared/types.js";

// PLAN — engineering-software-architect produces a technical plan.
// Uses codex (primary runner). Output schema is a tight Zod object so raw
// agent stdout never flows downstream unsanitized (security boundary).
const architectAgent = defineAgent({
  runner: "codex",
  input: z.object({
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    issueBody: z.string(),
  }),
  output: z.object({
    plan: z.string(),
    affectedPackages: z.array(z.string()),
    versionBumps: z.array(
      z.object({
        package: z.string(),
        kind: z.enum(["patch", "minor", "major"]),
      }),
    ),
    gate: z.enum(["APPROVED", "NEEDS_WORK"]),
  }),
  prompt: (input) => {
    const role = loadRoleSync("engineering-software-architect");
    return [
      role.body,
      "---",
      `Issue #${input.issueNumber}: ${input.issueTitle}`,
      "",
      input.issueBody,
      "",
      "## Required output (JSON)",
      "",
      "```json",
      "{",
      '  "plan": "<technical plan text>",',
      '  "affectedPackages": ["<pkg>"],',
      '  "versionBumps": [{ "package": "<pkg>", "kind": "patch" | "minor" | "major" }],',
      '  "gate": "APPROVED" | "NEEDS_WORK"',
      "}",
      "```",
      "",
      "Wrap your response in this JSON object exactly. Do not add prose around it.",
    ].join("\n");
  },
});

// BUILD — engineering-senior-developer implements the plan in the worktree.
// Session on build deferred to PR D where fix→test iteration needs it.
const seniorDeveloperAgent = defineAgent({
  runner: "codex",
  input: z.object({
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    plan: z.string(),
    affectedPackages: z.array(z.string()),
    worktreePath: z.string(),
  }),
  output: z.object({
    filesChanged: z.array(z.string()),
    summary: z.string(),
    typecheckPassed: z.boolean(),
  }),
  prompt: (input) => {
    const role = loadRoleSync("engineering-senior-developer");
    return [
      role.body,
      "---",
      `Feature issue #${input.issueNumber}: ${input.issueTitle}`,
      "",
      "Plan from architect:",
      input.plan,
      "",
      `Affected packages: ${input.affectedPackages.join(", ")}`,
      `Worktree: ${input.worktreePath}`,
      "",
      "Implement per the plan. Run typecheck + tests locally before returning.",
      "Only commit reality: typecheckPassed must reflect actual exit code.",
    ].join("\n");
  },
});

// VERIFY — engineering-code-reviewer reads the diff and decides the gate.
const codeReviewerAgent = defineAgent({
  runner: "codex",
  input: z.object({
    issueNumber: z.number().int().positive(),
    plan: z.string(),
    worktreePath: z.string(),
  }),
  output: z.object({
    findings: z.array(
      z.object({
        severity: z.enum(["blocker", "suggestion", "nit"]),
        path: z.string(),
        line: z.number().int().nonnegative().optional(),
        message: z.string(),
      }),
    ),
    gate: z.enum(["APPROVED", "NEEDS_WORK"]),
  }),
  prompt: (input) => {
    const role = loadRoleSync("engineering-code-reviewer");
    return [
      role.body,
      "---",
      `Issue #${input.issueNumber}`,
      `Worktree: ${input.worktreePath}`,
      "",
      "Architect's plan:",
      input.plan,
      "",
      "Run `git diff origin/master...HEAD` in the worktree and review the full diff.",
      "",
      "## Required output (JSON)",
      "",
      "```json",
      "{",
      '  "findings": [{ "severity": "blocker" | "suggestion" | "nit", "path": "<file>", "line": <n>, "message": "<text>" }],',
      '  "gate": "APPROVED" | "NEEDS_WORK"',
      "}",
      "```",
      "",
      "Wrap your response in this JSON object exactly. Do not add prose around it.",
    ].join("\n");
  },
});

// TEST — deterministic `bun test` runner. Captures output + exit code.
// Timeout 10 minutes — long enough for slow CI-like runs.
// reject: false — lets us capture the result on non-zero exit instead of throwing.
const testFn = defineFunction({
  name: "test",
  input: z.object({
    worktreePath: z.string(),
  }),
  output: z.object({
    passed: z.boolean(),
    output: z.string(),
    exitCode: z.number().int(),
  }),
  execute: async (input) => {
    try {
      const { stdout, stderr, exitCode } = await execa("bun", ["test"], {
        cwd: input.worktreePath,
        reject: false,
        timeout: 600_000,
      });
      const combinedOutput = `${stdout}\n${stderr}`.slice(-4000); // last 4KB
      return {
        passed: exitCode === 0,
        output: combinedOutput,
        exitCode: exitCode ?? -1,
      };
    } catch (err) {
      return {
        passed: false,
        output: err instanceof Error ? err.message : String(err),
        exitCode: -1,
      };
    }
  },
});

// SHIP — deterministic git + gh. Runs only when verify gate = APPROVED.
// Reads the current branch from the worktree so it works regardless of
// how the worktree was created (branch name already set by createWorktree).
const shipFn = defineFunction({
  name: "ship",
  input: z.object({
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    worktreePath: z.string(),
    filesChanged: z.array(z.string()),
    summary: z.string(),
    gate: z.enum(["APPROVED", "NEEDS_WORK"]),
  }),
  output: z.object({
    prNumber: z.number().int().positive().nullable(),
    branch: z.string(),
    commit: z.string(),
  }),
  execute: async (input) => {
    if (input.gate !== "APPROVED") {
      throw new Error(`ship blocked: verify gate = ${input.gate}`);
    }

    // Read the branch the worktree is already on (set by createWorktree).
    const { stdout: branch } = await execa(
      "git",
      ["branch", "--show-current"],
      { cwd: input.worktreePath },
    );
    const currentBranch = branch.trim();

    // Stage changed files. Guard against hallucinated paths: skip files that fail.
    for (const file of input.filesChanged) {
      await execa("git", ["add", "--", file], {
        cwd: input.worktreePath,
      }).catch((err) =>
        console.warn(
          `[ship] git add ${file} failed: ${(err as Error).message}`,
        ),
      );
    }

    const commitMsg = `feat: #${input.issueNumber} — ${input.summary}\n\nCloses #${input.issueNumber}`;
    await execa("git", ["commit", "-m", commitMsg], {
      cwd: input.worktreePath,
    });

    const { stdout: commit } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: input.worktreePath,
    });

    await execa("git", ["push", "-u", "origin", currentBranch], {
      cwd: input.worktreePath,
    });

    const body = `## Summary\n\n${input.summary}\n\nCloses #${input.issueNumber}`;
    const { stdout: prUrl } = await execa(
      "gh",
      [
        "pr",
        "create",
        "--head",
        currentBranch,
        "--title",
        `feat: #${input.issueNumber} — ${input.issueTitle}`,
        "--body",
        body,
      ],
      { cwd: input.worktreePath },
    );

    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : null;

    return { prNumber, branch: currentBranch, commit: commit.trim() };
  },
});

export const createFeaturePipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "feature-pipeline",
    tasks: {
      // PLAN phase — architect produces the technical plan.
      plan: {
        agent: architectAgent,
        input: () => ({
          issueNumber: input.issue.number,
          issueTitle: input.issue.title,
          issueBody: input.issue.body,
        }),
      },

      // BUILD phase — senior-developer implements plan in worktree.
      build: {
        agent: seniorDeveloperAgent,
        dependsOn: ["plan"] as const,
        input: (ctx: {
          plan: {
            output: { plan: string; affectedPackages: readonly string[] };
          };
        }) => ({
          issueNumber: input.issue.number,
          issueTitle: input.issue.title,
          plan: ctx.plan.output.plan,
          affectedPackages: [...ctx.plan.output.affectedPackages],
          worktreePath: input.worktreePath,
        }),
      },

      // TEST phase — run `bun test` in worktree deterministically.
      test: {
        fn: testFn,
        dependsOn: ["build"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // VERIFY phase — code-reviewer returns APPROVED / NEEDS_WORK.
      // Depend on both `test` (for ordering) and `plan` (for the plan text
      // passed to the reviewer's prompt). `CtxFor` only exposes direct
      // dependencies, so `plan` must be listed here.
      verify: {
        agent: codeReviewerAgent,
        dependsOn: ["test", "plan"] as const,
        input: (ctx: {
          plan: { output: { plan: string } };
        }) => ({
          issueNumber: input.issue.number,
          plan: ctx.plan.output.plan,
          worktreePath: input.worktreePath,
        }),
      },

      // SHIP phase — push branch + open PR via gh.
      ship: {
        fn: shipFn,
        dependsOn: ["verify", "build"] as const,
        input: (ctx: {
          build: {
            output: { filesChanged: readonly string[]; summary: string };
          };
          verify: { output: { gate: "APPROVED" | "NEEDS_WORK" } };
        }) => ({
          issueNumber: input.issue.number,
          issueTitle: input.issue.title,
          worktreePath: input.worktreePath,
          filesChanged: [...ctx.build.output.filesChanged],
          summary: ctx.build.output.summary,
          gate: ctx.verify.output.gate,
        }),
      },
    },
  }),
);
