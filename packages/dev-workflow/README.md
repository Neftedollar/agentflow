# @ageflow/dev-workflow

Dogfood package: ageflow running its own engineering pipeline.

## Purpose

Every code change to the ageflow monorepo goes through this pipeline:
PLAN → BUILD → TEST → VERIFY → SHIP — implemented as an ageflow workflow.
This is the strategic commitment from issue #194 to use our own tool in anger.

## Status: in active dogfood rollout (issue #194)

| Sub-PR | Status | Contents |
|--------|--------|----------|
| 1 | merged | Package scaffold, pipeline stubs, run.ts wiring |
| 2 | pending | Role library + ageflow-orchestrator role |
| 3 | pending | Learning hooks + SQLite store |
| 4 | in progress | Real issue runs through dogfood with live stream progress |
| 5 | pending | 10-run retrospective + tuning |

## Invoke (once sub-PR 4 is merged)

```sh
# Run pipeline for a GitHub issue:
bun run --filter @ageflow/dev-workflow dev-workflow <issue-number>

# Dry-run (no LLM calls, logs would-be plan):
bun run --filter @ageflow/dev-workflow dev-workflow --dry-run <issue-number>
```

Live (non-dry) runs stream workflow progress to stdout, including task start/completion,
per-task durations, running spend in USD, and budget-cap progress/warnings.

## What is NOT implemented yet

- **Real LLM tasks** — pipeline stubs use `defineFunction` no-ops. Real
  role-based agents land in sub-PR 2.
- **Git worktree creation** — `createWorktree()` logs the would-be command
  but does not run `git worktree add`. Real call lands in sub-PR 4.
- **Learning hooks** — `@ageflow/learning` is declared as a dependency but
  not wired. Integration lands in sub-PR 3.
- **Role library** — standing roles parsed from CLAUDE.md focus keywords
  land in sub-PR 2 alongside the ageflow-orchestrator role definition.

## Package structure

```
packages/dev-workflow/
├── run.ts               ← entry point (issue loader + pipeline router)
├── CLAUDE.md            ← focus keywords + project rules for AI agents
├── pipelines/
│   ├── feature.ts       ← PLAN → BUILD → TEST → VERIFY → SHIP
│   ├── bugfix.ts        ← TRIAGE → REPRODUCE → FIX → TEST → VERIFY → SHIP
│   ├── docs.ts          ← DRAFT → REVIEW → PUBLISH
│   └── release.ts       ← CHANGELOG → BUMP → PUBLISH → ANNOUNCE
└── shared/
    ├── types.ts          ← Issue, PipelineType, WorkflowInput schemas
    ├── issue-loader.ts   ← loadIssue() + determinePipeline() via gh CLI
    ├── runners.ts        ← initRunners() (codex primary, claude optional)
    └── worktree.ts       ← createWorktree() + removeWorktree() stubs
```
