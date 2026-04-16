# AgentFlow — Code Workspace

Bun monorepo. Main entry: `packages/core/`.

## Commands
- `bun install` — install deps
- `bun run build` — build all packages
- `bun run test` — run all tests
- `bun run typecheck` — type-check all packages
- `bun run lint` — lint with Biome

## Package dependency order (critical path)
core ← executor ← cli
core ← runners/claude
core ← runners/codex
core ← testing
executor ← testing
runners/* ← executor (via RunnerRegistry)
core ← server
executor ← server

## Packages (v1)
- `@ageflow/core` — types, Zod schemas, DSL builders
- `@ageflow/executor` — DAG executor, loop, session, HITL, budget, pre-flight
- `@ageflow/runner-claude` — Claude CLI subprocess runner
- `@ageflow/runner-codex` — Codex CLI subprocess runner
- `@ageflow/runner-api` — OpenAI-compatible HTTP runner
- `@ageflow/testing` — test harness (`createTestHarness`)
- `@ageflow/server` — embeddable execution surface — streaming events, async HITL, cancellation
- `agentflow` (CLI) — `agentwf run/validate/dry-run/init`

## Phase 1 complete: @agentflow/core
## Phases 2-6: executor, runners, testing, CLI, examples
## Phase 7+: @ageflow/server (#26)
## Phase 7: agents use MCP servers (#19) — MCP integration across all 3 runners, API runner in-process MCP client; new `@modelcontextprotocol/sdk` runtime dep on `@ageflow/runner-api` and `@ageflow/testing`
