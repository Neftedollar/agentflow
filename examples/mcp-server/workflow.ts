/**
 * workflow.ts — Minimal "greet" MCP workflow.
 *
 * Exposes a single `greet` tool via the MCP protocol:
 *   Input:  { name: string }
 *   Output: { greeting: string }
 *
 * Start the server:
 *   bun run serve               # listens on stdio, HITL = elicit (default)
 *   bun run serve:auto          # HITL = auto (no human approval needed)
 *
 * Or run the integration test:
 *   bun run test
 */

import { defineWorkflow, registerRunner } from "@ageflow/core";
import { ClaudeRunner } from "@ageflow/runner-claude";
import { greetAgent } from "./agents/greet.js";

// Register the Claude runner so executor can dispatch agent calls.
// This is a top-level side effect that runs when the file is imported.
registerRunner("claude", new ClaudeRunner());

export default defineWorkflow({
  name: "greet",
  mcp: {
    description: "Greet a person by name and return a friendly message.",
    maxCostUsd: 0.1,
    maxDurationSec: 30,
    maxTurns: 5,
  },
  tasks: {
    greet: {
      agent: greetAgent,
    },
  },
});
