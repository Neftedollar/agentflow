# dev-workflow — AgentFlow Engineering Operations

This package is the dogfood engineering loop for the ageflow monorepo itself.
It implements a multi-stage pipeline (PLAN → BUILD → TEST → VERIFY → SHIP)
as an ageflow workflow. Every product-code change to ageflow goes through it.

**Design spec:** `../../docs/superpowers/specs/2026-04-15-agentflow-design.md`

**Status:** Sub-PR 1 of 5 from issue #194 — scaffold only, no real LLM tasks yet.

**How to invoke:**
```
bun run --filter @ageflow/dev-workflow dev-workflow <issue-number>
bun run --filter @ageflow/dev-workflow dev-workflow --dry-run <issue-number>
```

## Focus keywords (activate standing roles)

ageflow touches these domains:

- **TypeScript, Bun, monorepo, Turborepo, Vitest** — baseline toolchain
- **ageflow, DSL, defineAgent, defineWorkflow, loop, executor** — core framework
- **runner-claude, runner-codex, runner-api, MCP, subprocess** — runner surface
- **learning, learning-sqlite, reflection, skill injection** — learning layer
- **security, prompt injection, Zod, safePath, sanitizeInput** — security surface
- **DX, CLI, typechecking, lint, biome** — developer experience

Parsed by focus-parser (sub-PR 2) → standing roles per `docs/role-capabilities.md`:

- `security` / `prompt injection` / `Zod` → `engineering-security-engineer` at PLAN + VERIFY
- `ageflow` / `LLM` / `MCP` → `engineering-ai-engineer` at PLAN + BUILD + VERIFY
- `DX` / `CLI` / `typescript` → `engineering-software-architect` at PLAN + VERIFY
- `executor` / `runner` → `engineering-backend-architect` at PLAN + VERIFY

## Project-specific rules

- **Spec adherence.** Every code change is reviewed against the agentflow design
  doc (`docs/superpowers/specs/2026-04-15-agentflow-design.md`) by a
  `spec-adherence-reviewer` role at VERIFY step (sub-PR 2+).
- **Version bumps.** Follow semver: patch for fixes, minor for features.
  Bump in package.json only — changeset automation TBD.
- **No publish.** This package is `private: true` — never published to npm.
- **dev-workflow writes only to `packages/` and `docs/`**, never to its own
  source tree during a pipeline execution run.
- **No real LLM calls in this file or shared/** until sub-PR 4.
