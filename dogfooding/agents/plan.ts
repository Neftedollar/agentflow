import { defineAgent } from "@ageflow/core";
import { z } from "zod";

/**
 * PLAN step — PM + Architect in one pass.
 * Given a GitHub issue, produces a structured implementation plan:
 * - Affected files and packages
 * - Step-by-step implementation guide
 * - Acceptance criteria for VERIFY
 */
export const planAgent = defineAgent({
  runner: "claude",
  model: "claude-opus-4-6",
  input: z.object({
    issue: z.object({
      number: z.number(),
      title: z.string(),
      body: z.string(),
      labels: z.array(z.string()),
    }),
    repoPath: z.string(),
  }),
  output: z.object({
    summary: z.string(),
    affectedPackages: z.array(z.string()),
    affectedFiles: z.array(z.string()),
    steps: z.array(
      z.object({
        order: z.number(),
        description: z.string(),
        file: z.string().optional(),
      }),
    ),
    acceptanceCriteria: z.array(z.string()),
    estimatedComplexity: z.enum(["trivial", "small", "medium", "large"]),
    requiresCeoApproval: z.boolean(),
    ceoApprovalReason: z.string().optional(),
  }),
  prompt: ({ issue, repoPath }) =>
    `You are a senior software architect. Analyze this GitHub issue and produce an implementation plan.

Issue #${issue.number}: ${issue.title}
Labels: ${issue.labels.join(", ")}
Repository: ${repoPath}

Description:
${issue.body}

Produce a JSON implementation plan with:
- summary: one-sentence description of what needs to be done
- affectedPackages: list of package names (e.g. ["@ageflow/core", "@ageflow/executor"])
- affectedFiles: list of file paths relative to repo root
- steps: ordered implementation steps, each with { order, description, file? }
- acceptanceCriteria: list of verifiable conditions that must be true when done
- estimatedComplexity: "trivial" | "small" | "medium" | "large"
- requiresCeoApproval: true if this is a breaking API change, public content, or costly infra decision
- ceoApprovalReason: explain why if requiresCeoApproval is true`,
  retry: {
    max: 2,
    on: ["subprocess_error", "output_validation_error"],
    backoff: "exponential",
  },
});
