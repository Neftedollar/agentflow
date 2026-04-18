// Feature pipeline — PLAN → BUILD → TEST → VERIFY → SHIP DAG.
//
// Sub-PR 1: skeleton stub. All tasks are defineFunction no-ops that return {}.
// Real role-based agents land in sub-PR 2. LLM dispatch lands in sub-PR 4.
//
// Uses defineWorkflowFactory to validate the helper works in production code
// (part of the dogfood proof — closes the loop on #192/#196).

import { defineFunction, defineWorkflowFactory } from "@ageflow/core";
import { z } from "zod";
import type { WorkflowInput } from "../shared/types.js";

const noopFn = defineFunction({
  name: "noop",
  input: z.object({}).passthrough(),
  output: z.object({}),
  execute: async () => ({}),
});

export const createFeaturePipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "feature-pipeline",
    tasks: {
      // PLAN phase — parallel design/security/ai review.
      // Sub-PR 2: replace with real role agents (pm, architect, security, ai).
      plan: {
        fn: noopFn,
        input: () => ({ issueNumber: input.issue.number }),
      },

      // BUILD phase — implement plan in worktree.
      // Sub-PR 2: replace with build role agent + session sharing.
      build: {
        fn: noopFn,
        dependsOn: ["plan"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // TEST phase — run `bun test` in worktree.
      // Sub-PR 2: replace with test-runner agent.
      test: {
        fn: noopFn,
        dependsOn: ["build"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // VERIFY phase — reality-check + code-review + security-review.
      // Sub-PR 2: replace with verify role agents + loop for re-work.
      verify: {
        fn: noopFn,
        dependsOn: ["test"] as const,
        input: () => ({}),
      },

      // SHIP phase — push branch + open PR via gh.
      // Sub-PR 2: replace with ship agent.
      ship: {
        fn: noopFn,
        dependsOn: ["verify"] as const,
        input: () => ({ issueNumber: input.issue.number }),
      },
    },
  }),
);
