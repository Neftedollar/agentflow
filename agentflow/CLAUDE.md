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

## Phase 1 complete: @agentflow/core
## Phases 2-6: executor, runners, testing, CLI, examples
