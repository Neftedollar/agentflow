/**
 * workflow.ts — Minimal "summarize" API runner workflow.
 *
 * Calls any OpenAI-compatible endpoint to produce a one-sentence summary.
 *
 * Run live (requires OPENAI_API_KEY or compatible endpoint):
 *   bun run demo
 *
 * Run with injected mock fetch (no credentials needed):
 *   AGENTFLOW_MOCK=1 bun run demo
 *
 * Run tests (always uses mock):
 *   bun run test
 */

import { defineWorkflow, registerRunner } from "@ageflow/core";
import { ApiRunner } from "@ageflow/runner-api";
import { summarize } from "./agents/summarize.js";

// In mock mode inject a canned fetch; otherwise use globalThis.fetch.
const fetchImpl =
  process.env.AGENTFLOW_MOCK === "1"
    ? (await import("./__mocks__/fetch-mock.js")).mockFetch
    : undefined;

registerRunner(
  "api",
  new ApiRunner({
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "mock-key",
    defaultModel: "gpt-4o-mini",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  }),
);

export const workflow = defineWorkflow({
  name: "api-runner-demo",
  tasks: {
    summarize: {
      agent: summarize,
      input: {
        text: "AgentFlow ships the API runner — a zero-dependency OpenAI-compatible HTTP runner for multi-agent TypeScript workflows.",
      },
    },
  },
});

// When executed directly (bun workflow.ts), run and print the result.
if (import.meta.main) {
  const { WorkflowExecutor } = await import("@ageflow/executor");
  const executor = new WorkflowExecutor(workflow);
  const result = await executor.run({});
  console.log(JSON.stringify(result.outputs, null, 2));
}
