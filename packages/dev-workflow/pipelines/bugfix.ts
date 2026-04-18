// Bugfix pipeline — TRIAGE → REPRODUCE → FIX → TEST → VERIFY → SHIP.
//
// Sub-PR 1: skeleton stub. All tasks are defineFunction no-ops returning {}.
// Real role-based agents (triage analyst, engineer, code reviewer) land in
// sub-PR 2. LLM dispatch lands in sub-PR 4.

import { defineFunction, defineWorkflowFactory } from "@ageflow/core";
import { z } from "zod";
import type { WorkflowInput } from "../shared/types.js";

const noopFn = defineFunction({
  name: "noop",
  input: z.object({}).passthrough(),
  output: z.object({}),
  execute: async () => ({}),
});

export const createBugfixPipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "bugfix-pipeline",
    tasks: {
      // TRIAGE — classify severity, identify affected files.
      // Sub-PR 2: replace with triage-analyst agent.
      triage: {
        fn: noopFn,
        input: () => ({ issueNumber: input.issue.number }),
      },

      // REPRODUCE — write a failing test that captures the bug.
      // Sub-PR 2: replace with engineer agent.
      reproduce: {
        fn: noopFn,
        dependsOn: ["triage"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // FIX — implement the minimal code change.
      // Sub-PR 2: replace with build role agent.
      fix: {
        fn: noopFn,
        dependsOn: ["reproduce"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // TEST — confirm the failing test now passes.
      // Sub-PR 2: replace with test-runner agent.
      test: {
        fn: noopFn,
        dependsOn: ["fix"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // VERIFY — regression check + security review.
      // Sub-PR 2: replace with verify agents + loop for rework.
      verify: {
        fn: noopFn,
        dependsOn: ["test"] as const,
        input: () => ({}),
      },

      // SHIP — push branch + open PR.
      // Sub-PR 2: replace with ship agent.
      ship: {
        fn: noopFn,
        dependsOn: ["verify"] as const,
        input: () => ({ issueNumber: input.issue.number }),
      },
    },
  }),
);
