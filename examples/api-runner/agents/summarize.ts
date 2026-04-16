/**
 * summarize.ts — Summarizer agent definition.
 *
 * Takes a `text` string and returns a one-sentence `summary`.
 * Expects the model to reply with JSON: { "summary": "<one sentence>" }
 */

import { defineAgent } from "@ageflow/core";
import { z } from "zod";

export const summarize = defineAgent({
  runner: "api",
  model: "gpt-4o-mini",
  input: z.object({
    text: z.string().describe("The text to summarize"),
  }),
  output: z.object({
    summary: z.string().describe("A one-sentence summary"),
  }),
  prompt: (i) =>
    `Summarize the following in one sentence. Reply ONLY with a JSON object matching: { "summary": "<one sentence>" }\n\n${i.text}`,
  sanitizeInput: true,
});
