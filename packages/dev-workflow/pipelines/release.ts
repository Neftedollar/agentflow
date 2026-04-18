// Release pipeline — CHANGELOG → BUMP → PUBLISH → ANNOUNCE.
//
// Used for issues labelled `release`. Covers semver bumps, npm publish,
// and GitHub release creation for the @ageflow/* packages.
//
// Sub-PR 1: skeleton stub. All tasks are defineFunction no-ops returning {}.
// Real role-based agents (tech-writer, devops, ship) land in sub-PR 2.

import { defineFunction, defineWorkflowFactory } from "@ageflow/core";
import { z } from "zod";
import type { WorkflowInput } from "../shared/types.js";

const noopFn = defineFunction({
  name: "noop",
  input: z.object({}).passthrough(),
  output: z.object({}),
  execute: async () => ({}),
});

export const createReleasePipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "release-pipeline",
    tasks: {
      // CHANGELOG — summarise commits since last tag into CHANGELOG.md.
      // Sub-PR 2: replace with tech-writer agent reading git log.
      changelog: {
        fn: noopFn,
        input: () => ({ issueNumber: input.issue.number }),
      },

      // BUMP — update package.json versions across affected packages.
      // Sub-PR 2: replace with engineer agent following semver rules.
      bump: {
        fn: noopFn,
        dependsOn: ["changelog"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // PUBLISH — bun publish for each changed package.
      // Sub-PR 2: replace with devops agent + dry-run guard.
      publish: {
        fn: noopFn,
        dependsOn: ["bump"] as const,
        input: () => ({ worktreePath: input.worktreePath }),
      },

      // ANNOUNCE — create GitHub release + tag.
      // Sub-PR 2: replace with ship agent calling gh release create.
      announce: {
        fn: noopFn,
        dependsOn: ["publish"] as const,
        input: () => ({
          issueNumber: input.issue.number,
          worktreePath: input.worktreePath,
        }),
      },
    },
  }),
);
