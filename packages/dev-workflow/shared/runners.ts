// Runner registration for dev-workflow.
//
// Primary runner: "codex" (CLI subprocess, auth via ChatGPT OAuth).
// Optional: "claude" (requires ANTHROPIC_API_KEY — separate billing).
//
// Codex is preferred as primary because the Claude Code OAuth session is not
// forwarded to child processes (claude --print subprocess has no Claude Code
// session), whereas codex authenticates via ChatGPT OAuth in-subprocess.
//
// ClaudeRunner and CodexRunner constructors accept no required args —
// model, timeout, maxToolRounds come from RunnerSpawnArgs at task execution
// time. Auth is sourced from each CLI's own credential store.

import { registerRunner } from "@ageflow/core";
import { ClaudeRunner } from "@ageflow/runner-claude";
import { CodexRunner } from "@ageflow/runner-codex";

let initialized = false;

/** Register ageflow runners. Idempotent — safe to call multiple times. */
export function initRunners(): void {
  if (initialized) return;
  initialized = true;

  // Primary runner for all agent tasks.
  registerRunner("codex", new CodexRunner());

  // Optional secondary runner. Sub-PR 4 wires role-level runner selection.
  registerRunner("claude", new ClaudeRunner());
}
