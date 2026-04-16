# @ageflow/cli

[![npm](https://img.shields.io/npm/v/@ageflow/cli)](https://www.npmjs.com/package/@ageflow/cli)

CLI for [ageflow](../../README.md) — scaffold, validate, preview, and run multi-agent workflows.

## Install

```bash
bun add -g @ageflow/cli
# or
npx @ageflow/cli <command>
```

## Commands

### `agentwf init <project-name>`

Scaffold a new workflow project:

```bash
agentwf init my-workflow
cd my-workflow
bun install
agentwf run workflow.ts
```

Generates:
```
my-workflow/
├── workflow.ts       ← ready-to-edit workflow definition
├── agents/           ← put your agent files here
└── package.json      ← run/validate/dry-run scripts
```

---

### `agentwf validate <workflow-file>`

Run preflight checks without executing any agents:

```bash
agentwf validate workflow.ts
```

Checks:
- All runner CLIs are installed and on `PATH` (`claude`, `codex`)
- DAG has no cycles
- All `dependsOn` references exist
- Session cross-provider conflicts (e.g. a `claude` session used by a `codex` agent)

---

### `agentwf dry-run <workflow-file>`

Print the resolved execution plan and rendered prompts without running anything:

```bash
agentwf dry-run workflow.ts
```

Output shows:
- Execution batches (which tasks run in parallel)
- Each task's runner and rendered prompt (with placeholder inputs for dynamic prompts)
- Loop structure

---

### `agentwf run <workflow-file>`

Run the workflow end-to-end:

```bash
agentwf run workflow.ts
```

Options set in the workflow definition (not flags):
- `budget` — max cost in USD; workflow halts if exceeded
- `hooks.onCheckpoint` — HITL pause before a task
- `retry` — per-task retry config

## Requirements

- Bun ≥ 1.0 or Node.js ≥ 18
- [`claude` CLI](https://github.com/anthropics/claude-code) for Claude agents
- [`codex` CLI](https://github.com/openai/codex) for Codex agents

## License

MIT
