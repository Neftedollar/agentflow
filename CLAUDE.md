# AgentFlow — Developer Workspace

TypeScript embedded DSL + local CLI executor for multi-agent AI workflows.

**Founder:** Roman. **Team:** AI agents. **Phase:** v1 build.

---

## How to start (required for every session)

### 1. Determine mode

| If the CEO... | Mode | What to do |
|----------------|-------|------------|
| Called `/orchestrator <task>` | **CEO Mode** | You = orchestrator. Read `docs/process.md`, then execute. |
| Called `/<role> <question>` | **Single Expert** | You = that role. Answer as expert, no pipeline. |
| Just asked a question | **Chief of Staff** | You = advisor. Help, suggest next step, recommend a role or `/orchestrator`. |
| Launched via `claude -p` | **Autonomous** | You = orchestrator. Read `docs/process.md`, pick tasks from backlog. |

### 2. Load context (depends on mode)

**Always read:**
- This file (already loaded)

**If task involves code:**
- See "Code Workspace" section below for build, test, and architecture guidance

**If you are orchestrator (CEO Mode / Autonomous):**
- `docs/process.md` — **operational manual** (pipelines, gates, escalation, retry). Source of truth.
- `docs/role-capabilities.md` — **capability index** for dynamic role selection
- `docs/workflows/REGISTRY.md` — workflow registry

### 3. Act

- **Orchestrator**: follow pipeline from `docs/process.md`. Select roles via `docs/role-capabilities.md`. Don't hardcode.
- **Single Expert**: answer within your role. No pipeline.
- **Chief of Staff**: help CEO. Suggest `/orchestrator` for pipeline tasks.

---

## Workspace structure

```
agents-workflow/          ← this workspace
├── packages/             ← Bun monorepo (core entry)
├── examples/             ← example workflows
├── dogfooding/           ← dogfooding workflows
├── docs/
│   ├── process.md        ← operational manual
│   ├── role-capabilities.md
│   ├── workflows/        ← REGISTRY.md + WORKFLOW-*.md
│   └── superpowers/
│       └── specs/        ← design specs
│           └── 2026-04-15-agentflow-design.md
├── .claude/
│   └── commands/         ← slash commands
├── package.json          ← monorepo root
├── tsconfig.base.json
├── turbo.json
├── biome.json
└── CLAUDE.md             ← this file
```

---

## Project: AgentFlow

**What it is:** TypeScript embedded DSL for writing AI agent workflow instructions. Multi-agent DAG execution with type-safe I/O via Zod.

**Design spec:** `docs/superpowers/specs/2026-04-15-agentflow-design.md`

**Implementation plan:** `~/.claude/plans/toasty-yawning-bachman.md`

**Stack:**
- Runtime: Bun
- Monorepo: Bun workspaces + Turborepo
- Testing: Vitest
- TypeScript: strict mode
- CLI output: chalk + ora + boxen

**Packages (v1):**
- `@agentflow/core` — types, Zod schemas, DSL builders (`defineAgent`, `defineWorkflow`, `loop`, `safePath`)
- `@agentflow/executor` — DAG executor, loop, session, HITL, budget, pre-flight
- `@agentflow/runners/claude` — Claude CLI subprocess runner
- `@agentflow/runners/codex` — Codex CLI subprocess runner
- `@agentflow/testing` — test harness (`createTestHarness`)
- `agentflow` (CLI) — `agentwf run/validate/dry-run/init`

**Key design decisions:**
- Subprocess model — no HTTP API, CLIs manage their own auth
- Provider-typed sessions — `AgentDef<I, O, R>` carries runner brand, cross-provider session sharing = TypeScript error + pre-flight warning
- Zod as security boundary — raw stdout never passed downstream
- `sanitizeInput: true` default — prompt injection protection
- `safePath()` — path traversal Zod refinement

---

## Team (AI agents)

**CEO** — Roman. Sets direction, makes strategic decisions.

**Chief of Staff** — Claude in this workspace (default). Coordinates, helps, suggests next steps.

**Orchestrator** (`/orchestrator`) — autonomous pipeline manager.

Key roles:

| Layer | Roles |
|-------|-------|
| **Strategy** | `/product-manager` |
| **Management** | `/orchestrator`, `/testing-reality-checker` |
| **Engineering** | `/engineering-software-architect`, `/engineering-ai-engineer`, `/engineering-security-engineer` |

## Models by role

| Tier | Model | When |
|------|-------|------|
| Strategic | opus | PM, Architects, Security, Orchestrator |
| Execution | sonnet | Coder, DevOps, Tech Writer |
| Validation | opus | Reality Checker, Code Reviewer |
| Routine | haiku | Data gathering, lookups |

## Backlog

GitHub issues (repo TBD — to be created when agentflow monorepo is set up).

## Rules

- **Confirm intent**: on ambiguous requests — clarify before acting.
- **Code**: all code changes in `packages/`. Modify only via git worktree.
- **Worktree**: modify code only via git worktree. Main directory = read-only for pipeline.
- **Don't overengineer**: implementation plan phases 1→6, follow order.
- **Type safety everywhere**: non-functional requirement — every DSL call must be type-safe end-to-end.

---

## Code Workspace

Bun monorepo. Main entry: `packages/core/`.

### Commands
- `bun install` — install deps
- `bun run build` — build all packages
- `bun run test` — run all tests
- `bun run typecheck` — type-check all packages
- `bun run lint` — lint with Biome

### Package dependency order (critical path)
```
core ← executor ← cli
core ← runners/claude
core ← runners/codex
core ← testing
executor ← testing
runners/* ← executor (via RunnerRegistry)
core ← server
executor ← server
server ← mcp-server   ← @ageflow/mcp-server depends on @ageflow/server (async job mode, Phase 11 #18)
```

### Packages (v1)
- `@ageflow/core` — types, Zod schemas, DSL builders
- `@ageflow/executor` — DAG executor, loop, session, HITL, budget, pre-flight
- `@ageflow/runner-claude` — Claude CLI subprocess runner
- `@ageflow/runner-codex` — Codex CLI subprocess runner
- `@ageflow/runner-api` — OpenAI-compatible HTTP runner
- `@ageflow/testing` — test harness (`createTestHarness`)
- `@ageflow/server` — embeddable execution surface — streaming events, async HITL, cancellation
- `@ageflow/mcp-server` — MCP transport layer; depends on `@ageflow/server` for async job mode (createRunner, RunHandle)
- `agentflow` (CLI) — `agentwf run/validate/dry-run/init`

### Development phases
- Phase 1 complete: @agentflow/core
- Phases 2-6: executor, runners, testing, CLI, examples
- Phase 7+: @ageflow/server (#26)
- Phase 7: agents use MCP servers (#19) — MCP integration across all 3 runners, API runner in-process MCP client; new `@modelcontextprotocol/sdk` runtime dep on `@ageflow/runner-api` and `@ageflow/testing`
