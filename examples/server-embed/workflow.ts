/**
 * workflow.ts — Triage demo workflow with a HITL checkpoint.
 *
 * Classifies an incoming message as urgent/non-urgent, then pauses for
 * human approval before continuing.
 *
 * Start the server:
 *   bun server.ts
 *
 * Or run tests (no real API calls):
 *   bun run test
 */

import { defineAgent, defineWorkflow, registerRunner } from "@ageflow/core";
import { ApiRunner } from "@ageflow/runner-api";
import { z } from "zod";

registerRunner(
  "api",
  new ApiRunner({
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    defaultModel: "gpt-4o-mini",
  }),
);

const classify = defineAgent({
  runner: "api",
  model: "gpt-4o-mini",
  input: z.object({ message: z.string() }),
  output: z.object({ urgent: z.boolean(), summary: z.string() }),
  prompt: (i) =>
    `Classify: ${i.message}. Output JSON {urgent:boolean, summary:string}.`,
  hitl: { mode: "checkpoint", message: "Approve classification?" },
});

export const triageWorkflow = defineWorkflow({
  name: "triage",
  tasks: {
    classify: { agent: classify, input: { message: "Server is on fire" } },
  },
});
