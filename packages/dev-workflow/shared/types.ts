// Shared types for dev-workflow orchestrator, pipeline stubs, and utilities.
// Any external contract (GitHub issue, focus keywords, pipeline routing) is
// defined here so all modules share a single source of truth.

import { z } from "zod";

// ── GitHub issue as seen by the orchestrator ──────────────────────────────────
export const IssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  state: z.enum(["open", "closed"]),
  url: z.string().url(),
});
export type Issue = z.infer<typeof IssueSchema>;

// ── Pipeline type (determined by labels) ─────────────────────────────────────
export const PipelineTypeSchema = z.enum([
  "feature",
  "bugfix",
  "docs",
  "release",
]);
export type PipelineType = z.infer<typeof PipelineTypeSchema>;

// ── Workflow-level input passed into every pipeline factory ───────────────────
// Sub-PR 2 will extend this with roleSelection and focus fields.
export const WorkflowInputSchema = z.object({
  issue: IssueSchema,
  worktreePath: z.string(),
  // Absolute path to the ageflow design spec — for spec-adherence-reviewer
  // (standing role added in sub-PR 2).
  specPath: z.string(),
  // Dry-run flag: when true, no LLM agents are invoked (sub-PR 4 guard).
  dryRun: z.boolean().default(false),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;
