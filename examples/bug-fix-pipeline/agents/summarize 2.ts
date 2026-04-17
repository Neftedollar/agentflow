import { defineAgent } from "@ageflow/core";
import { z } from "zod";

export const summarizeAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({
    originalIssues: z.array(
      z.object({
        id: z.string(),
        file: z.string(),
        description: z.string(),
        severity: z.enum(["high", "medium", "low"]),
      }),
    ),
    fixResult: z.unknown(),
  }),
  output: z.object({
    report: z.string(),
    fixedCount: z.number(),
    remainingCount: z.number(),
  }),
  prompt: ({ originalIssues, fixResult }) =>
    `Write a summary report for a code review session.
Original issues found: ${originalIssues.length}
Fix result: ${JSON.stringify(fixResult)}
Return JSON: { report: string, fixedCount: number, remainingCount: number }`,
  retry: {
    max: 2,
    on: ["subprocess_error", "output_validation_error"],
    backoff: "exponential",
  },
});
