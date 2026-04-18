// Feature pipeline — PLAN → BUILD → TEST → VERIFY → SHIP DAG.
//
// Sub-PR 2: two tasks (plan, verify) are now real `defineAgent` calls that
// load their prompt from the role library via `loadRole()`. The remaining
// three (build, test, ship) stay as `defineFunction` no-ops — they land as
// real agents in sub-PR 4 alongside executor dispatch.
//
// This mixed-node shape is intentional: it exercises both the agent-with-
// role-prompt path and the deterministic `defineFunction` path inside the
// same DAG, proving the end-to-end wiring without yet calling the executor.

import {
  defineAgent,
  defineFunction,
  defineWorkflowFactory,
} from "@ageflow/core";
import { z } from "zod";
import { loadRoleSync } from "../shared/role-loader.js";
import type { WorkflowInput } from "../shared/types.js";

const noopFn = defineFunction({
  name: "noop",
  input: z.object({}).passthrough(),
  output: z.object({}),
  execute: async () => ({}),
});

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
      "Return the output block specified in the role, verbatim.",
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
      "Run `git diff master...HEAD` in the worktree and review the full diff.",
    ].join("\n");
  },
});

export const createFeaturePipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "feature-pipeline",
    tasks: {
      // PLAN phase — architect produces the technical plan.
      // Sub-PR 2: wired as real defineAgent. Sub-PR 4 runs the executor.
      plan: {
        agent: architectAgent,
        input: () => ({
          issueNumber: input.issue.number,
          issueTitle: input.issue.title,
          issueBody: input.issue.body,
        }),
      },

      // BUILD phase — implement plan in worktree.
      // Sub-PR 4: replace with engineering-senior-developer agent + session.
      build: {
        fn: noopFn,
        dependsOn: ["plan"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // TEST phase — run `bun test` in worktree.
      // Sub-PR 4: replace with a deterministic test-runner function.
      test: {
        fn: noopFn,
        dependsOn: ["build"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // VERIFY phase — code-reviewer returns APPROVED / NEEDS_WORK.
      // Sub-PR 2: wired as real defineAgent. Reality-checker + security
      // engineer land as parallel peers in sub-PR 3/4 (learning hooks).
      verify: {
        agent: codeReviewerAgent,
        // Depend on both `test` (for ordering) and `plan` (for the plan text
        // passed to the reviewer's prompt). `CtxFor` only exposes direct
        // dependencies, so `plan` must be listed here.
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
      // Sub-PR 4: replace with ship role (or defineFunction, TBD).
      ship: {
        fn: noopFn,
        dependsOn: ["verify"] as const,
        input: () => ({ issueNumber: input.issue.number }),
      },
    },
  }),
);
