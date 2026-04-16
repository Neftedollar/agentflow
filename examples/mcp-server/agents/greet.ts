/**
 * greet.ts — Greeter agent definition.
 *
 * Takes a `name` string and returns a friendly `greeting` string.
 * The prompt is intentionally simple so the example works with any Claude model.
 */

import { defineAgent } from "@ageflow/core";
import { z } from "zod";

export const greetAgent = defineAgent({
  runner: "claude",
  model: "claude-haiku-4-5",
  input: z.object({
    name: z.string().describe("The name of the person to greet"),
  }),
  output: z.object({
    greeting: z.string().describe("A friendly greeting message"),
  }),
  prompt: ({ name }) =>
    `You are a friendly assistant. Greet the person named "${name}" warmly in one sentence. Reply ONLY with a JSON object matching: { "greeting": "<your message>" }`,
  sanitizeInput: true,
});
