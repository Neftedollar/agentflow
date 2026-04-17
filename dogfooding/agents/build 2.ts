import { defineAgent } from "@ageflow/core";
import { z } from "zod";

const stepSchema = z.object({
  order: z.number(),
  description: z.string(),
  file: z.string().optional(),
});

/**
 * BUILD step — executes one implementation step from the plan.
 * Runs in a loop with testAgent: build → test → fix → test → ...
 * Uses a persistent session so the model retains context across retries.
 */
export const buildAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({
    plan: z.object({
      summary: z.string(),
      affectedFiles: z.array(z.string()),
      steps: z.array(stepSchema),
      acceptanceCriteria: z.array(z.string()),
    }),
    repoPath: z.string(),
    testFailure: z.string().optional(), // feedback from previous iteration
    previousPatch: z.string().optional(), // what was tried last time
  }),
  output: z.object({
    patch: z.string(), // unified diff or description of changes made
    filesChanged: z.array(z.string()),
    explanation: z.string(), // what was done and why
    confidence: z.number().min(0).max(10),
  }),
  prompt: ({ plan, repoPath, testFailure, previousPatch }) => {
    const retrySection =
      testFailure !== undefined
        ? `\n⚠️  Previous attempt failed tests:\n${testFailure}\n\nPrevious patch:\n${previousPatch ?? "(none)"}\n\nFix the issues above.`
        : "";

    return `You are a senior software engineer. Implement the following changes.

Repository: ${repoPath}
Task: ${plan.summary}

Implementation steps:
${plan.steps.map((s) => `${s.order}. ${s.description}${s.file ? ` (${s.file})` : ""}`).join("\n")}

Acceptance criteria:
${plan.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}
${retrySection}

Make the changes. Return JSON with:
- patch: unified diff of all changes (or detailed description if diff not available)
- filesChanged: list of modified file paths
- explanation: what you changed and why
- confidence: 0-10 how confident you are the tests will pass`;
  },
  retry: {
    max: 2,
    on: ["subprocess_error", "output_validation_error"],
    backoff: "exponential",
  },
});
