import { defineAgent } from "@agentflow/core";
import { z } from "zod";

export const analyzeAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({
    repoPath: z.string(),
    focus: z.string().optional(),
  }),
  output: z.object({
    issues: z.array(
      z.object({
        id: z.string(),
        file: z.string(),
        description: z.string(),
        severity: z.enum(["high", "medium", "low"]),
      }),
    ),
    summary: z.string(),
  }),
  prompt: ({ repoPath, focus }) =>
    `Analyze the codebase at ${repoPath}${focus ? ` focusing on ${focus}` : ""}.
Find bugs, security issues, and code quality problems.
Return a JSON object with:
- issues: array of { id, file, description, severity }
- summary: brief overview`,
  retry: {
    max: 2,
    on: ["subprocess_error", "output_validation_error"],
    backoff: "exponential",
  },
});
