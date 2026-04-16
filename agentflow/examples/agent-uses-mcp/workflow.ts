/**
 * workflow.ts — agent-uses-mcp cross-runner example.
 *
 * Demonstrates the same workflow config running under three different runners.
 * The only change is the `--runner` flag.
 *
 * Run with the API runner (requires OPENAI_API_KEY or compatible endpoint):
 *   bun workflow.ts --runner api
 *
 * Run with the Claude CLI runner (requires `claude` in PATH + ANTHROPIC_API_KEY):
 *   bun workflow.ts --runner claude
 *
 * Run with the Codex CLI runner (requires `codex` in PATH + OPENAI_API_KEY):
 *   bun workflow.ts --runner codex
 *
 * Run with a mock (no credentials needed):
 *   AGENTFLOW_MOCK=1 bun workflow.ts --runner api
 */

import { defineWorkflow, registerRunner } from "@ageflow/core";
import { auditAgent } from "./agents/audit.js";

// ─── Parse --runner flag ───────────────────────────────────────────────────────

const runnerArg =
  process.argv.find((a) => a.startsWith("--runner="))?.slice(9) ??
  process.argv[process.argv.indexOf("--runner") + 1];

const VALID_RUNNERS = ["api", "claude", "codex"] as const;
type RunnerKind = (typeof VALID_RUNNERS)[number];

function parseRunner(raw: string | undefined): RunnerKind {
  if (raw !== undefined && (VALID_RUNNERS as readonly string[]).includes(raw)) {
    return raw as RunnerKind;
  }
  console.error(
    `Usage: bun workflow.ts --runner <api|claude|codex>\nDefaulting to "api".`,
  );
  return "api";
}

const runner = parseRunner(runnerArg);

// ─── Register runner ──────────────────────────────────────────────────────────

if (runner === "api") {
  const { ApiRunner } = await import("@ageflow/runner-api");
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
} else if (runner === "claude") {
  const { ClaudeRunner } = await import("@ageflow/runner-claude");
  registerRunner("claude", new ClaudeRunner());
} else {
  const { CodexRunner } = await import("@ageflow/runner-codex");
  registerRunner("codex", new CodexRunner());
}

// ─── Workflow ─────────────────────────────────────────────────────────────────
//
// Single `audit` task — the agent is re-created with the selected runner so the
// DSL type flows through correctly. The MCP config and I/O schemas are identical
// across all three runner variants.

export const workflow = defineWorkflow({
  name: "agent-uses-mcp-demo",
  tasks: {
    audit: {
      agent: auditAgent(runner),
      input: { root: "." },
    },
  },
});

// ─── Entry point ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { WorkflowExecutor } = await import("@ageflow/executor");
  const executor = new WorkflowExecutor(workflow);
  const result = await executor.run({});
  console.log(JSON.stringify(result.outputs, null, 2));
}
