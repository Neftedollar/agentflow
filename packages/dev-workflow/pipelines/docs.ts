// Docs pipeline — DRAFT → REVIEW → PUBLISH.
//
// Used for issues labelled `docs` or `content`: API docs, README updates,
// design specs, and CLAUDE.md maintenance.
//
// Sub-PR 1: skeleton stub. All tasks are defineFunction no-ops returning {}.
// Real role-based agents (tech-writer, code-reviewer) land in sub-PR 2.

import { defineFunction, defineWorkflowFactory } from "@ageflow/core";
import { z } from "zod";
import type { WorkflowInput } from "../shared/types.js";

const noopFn = defineFunction({
  name: "noop",
  input: z.object({}).passthrough(),
  output: z.object({}),
  execute: async () => ({}),
});

export const createDocsPipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "docs-pipeline",
    tasks: {
      // DRAFT — write or update the documentation content.
      // Sub-PR 2: replace with technical-writer agent.
      draft: {
        fn: noopFn,
        input: () => ({
          issueNumber: input.issue.number,
          specPath: input.specPath,
        }),
      },

      // REVIEW — accuracy check against design spec and existing code.
      // Sub-PR 2: replace with code-reviewer + spec-adherence-reviewer agents.
      review: {
        fn: noopFn,
        dependsOn: ["draft"] as const,
        input: () => ({ specPath: input.specPath }),
      },

      // PUBLISH — commit changes + open PR.
      // Sub-PR 2: replace with ship agent.
      publish: {
        fn: noopFn,
        dependsOn: ["review"] as const,
        input: () => ({
          worktreePath: input.worktreePath,
          issueNumber: input.issue.number,
        }),
      },
    },
  }),
);
