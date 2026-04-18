// Bugfix pipeline — TRIAGE → REPRODUCE → FIX → TEST → VERIFY → SHIP.
//
// Sub-PR 2: `verify` is now a real `defineAgent` using the
// `testing-reality-checker` role. Reality-checking (run the code, not just
// read it) is the load-bearing gate for bugfix pipelines — a unit test
// that passes on master means the test didn't capture the bug, so the
// reality checker's job is to prove regression before approving.
//
// Other tasks stay as `defineFunction` stubs for sub-PR 4.

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

// VERIFY — reality-checker runs the test suite on master + branch and
// decides the gate based on evidence, not self-report.
const realityCheckerAgent = defineAgent({
  runner: "codex",
  input: z.object({
    issueNumber: z.number().int().positive(),
    worktreePath: z.string(),
  }),
  output: z.object({
    commandsRun: z.array(
      z.object({
        cmd: z.string(),
        result: z.enum(["PASS", "FAIL", "SKIPPED"]),
      }),
    ),
    regressionProof: z.string(),
    gate: z.enum(["APPROVED", "NEEDS_WORK"]),
  }),
  prompt: (input) => {
    const role = loadRoleSync("testing-reality-checker");
    return [
      role.body,
      "---",
      `Bugfix issue #${input.issueNumber}`,
      `Worktree: ${input.worktreePath}`,
      "",
      "Reproduce the bug on master, then verify the fix on the worktree",
      "branch. Cite the test file + describe block that captures the bug.",
    ].join("\n");
  },
});

export const createBugfixPipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "bugfix-pipeline",
    tasks: {
      // TRIAGE — classify severity, identify affected files.
      // Sub-PR 4: replace with triage-analyst agent.
      triage: {
        fn: noopFn,
        input: () => ({ issueNumber: input.issue.number }),
      },

      // REPRODUCE — write a failing test that captures the bug.
      // Sub-PR 4: replace with engineering-senior-developer agent.
      reproduce: {
        fn: noopFn,
        dependsOn: ["triage"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // FIX — implement the minimal code change.
      // Sub-PR 4: replace with engineering-senior-developer agent + session.
      fix: {
        fn: noopFn,
        dependsOn: ["reproduce"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // TEST — confirm the failing test now passes.
      // Sub-PR 4: replace with deterministic test-runner function.
      test: {
        fn: noopFn,
        dependsOn: ["fix"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // VERIFY — reality-checker proves the bug is actually gone.
      // Sub-PR 2: wired as real defineAgent. Code-reviewer peer lands in
      // sub-PR 4 as a parallel VERIFY step.
      verify: {
        agent: realityCheckerAgent,
        dependsOn: ["test"] as const,
        input: () => ({
          issueNumber: input.issue.number,
          worktreePath: input.worktreePath,
        }),
      },

      // SHIP — push branch + open PR.
      // Sub-PR 4: replace with ship role.
      ship: {
        fn: noopFn,
        dependsOn: ["verify"] as const,
        input: () => ({ issueNumber: input.issue.number }),
      },
    },
  }),
);
