import { defineAgent } from "@agentflow/core";
import { z } from "zod";

export const fixAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({
    issue: z.object({
      id: z.string(),
      file: z.string(),
      description: z.string(),
      severity: z.enum(["high", "medium", "low"]),
    }),
    previousAttempt: z.string().optional(),
  }),
  output: z.object({
    patch: z.string(),
    explanation: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  prompt: ({ issue, previousAttempt }) =>
    `Fix the following issue in ${issue.file}:
${issue.description}
${previousAttempt ? `\nPrevious attempt was rejected. Try a different approach.\nPrevious: ${previousAttempt}` : ""}
Return JSON: { patch: "diff content", explanation: "why this fixes it", confidence: 0.0-1.0 }`,
  hitl: { mode: "checkpoint", message: "Review this fix before applying?" },
  retry: {
    max: 2,
    on: ["subprocess_error", "output_validation_error"],
    backoff: "exponential",
  },
});
