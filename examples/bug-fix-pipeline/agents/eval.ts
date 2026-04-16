import { defineAgent } from "@ageflow/core";
import { z } from "zod";

export const evalAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({
    issue: z.object({
      id: z.string(),
      file: z.string(),
      description: z.string(),
      severity: z.enum(["high", "medium", "low"]),
    }),
    patch: z.string(),
    explanation: z.string(),
  }),
  output: z.object({
    satisfied: z.boolean(),
    feedback: z.string(),
    score: z.number().min(0).max(10),
  }),
  prompt: ({ issue, patch, explanation }) =>
    `Evaluate this fix for: ${issue.description}
Patch: ${patch}
Explanation: ${explanation}
Return JSON: { satisfied: boolean, feedback: string, score: 0-10 }`,
  retry: {
    max: 2,
    on: ["subprocess_error", "output_validation_error"],
    backoff: "exponential",
  },
});
