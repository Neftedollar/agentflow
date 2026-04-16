# ageflow

[![npm](https://img.shields.io/npm/v/@ageflow/core)](https://www.npmjs.com/package/@ageflow/core)
[![CI](https://github.com/Neftedollar/ageflow/actions/workflows/agentflow-ci.yml/badge.svg)](https://github.com/Neftedollar/ageflow/actions)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**TypeScript-first DSL for multi-agent AI workflows.** Define DAGs of AI agents with type-safe I/O, loops, sessions, and human-in-the-loop checkpoints — then run them locally or in CI with a single command.

```ts
import { defineAgent, defineWorkflow, registerRunner } from "@ageflow/core";
import { ClaudeRunner } from "@ageflow/runner-claude";
import { z } from "zod";

registerRunner("claude", new ClaudeRunner());

const reviewAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({ code: z.string() }),
  output: z.object({ issues: z.array(z.string()), approved: z.boolean() }),
  prompt: ({ code }) => `Review this code and list issues:\n\n${code}`,
});

export default defineWorkflow({
  name: "code-review",
  tasks: {
    review: { agent: reviewAgent, input: { code: "const x = eval(input)" } },
  },
});
```

```bash
npx @ageflow/cli run workflow.ts
```

## Why ageflow?

| Feature | What it means |
|---|---|
| **Type-safe I/O** | Zod schemas validate every agent's input and output — bad data never reaches the next task |
| **DAG execution** | Tasks run in parallel when possible, in order when they depend on each other |
| **Loops** | Iterative refinement (fix → evaluate → fix again) with persistent or fresh session context |
| **Sessions** | Share conversation context between agents — the model remembers what it said earlier |
| **HITL** | Pause a workflow for human approval before a task runs |
| **Budget guard** | Set a max cost; the workflow stops before you overspend |
| **Test harness** | Swap real CLI runners for mocks — test workflows in milliseconds, no API calls |
| **Subprocess model** | No HTTP server. Agents are CLI subprocesses (`claude`, `codex`) — auth lives in the CLI |

## Installation

```bash
# Core DSL + a runner
bun add @ageflow/core @ageflow/runner-claude

# CLI (global)
bun add -g @ageflow/cli
```

## Quick start

```bash
# Scaffold a new project
agentwf init my-workflow
cd my-workflow
bun install

# Preview prompts without running agents
agentwf dry-run workflow.ts

# Validate DAG and runner availability
agentwf validate workflow.ts

# Run
agentwf run workflow.ts
```

## Packages

| Package | Description |
|---|---|
| [`@ageflow/core`](packages/core) | Types, Zod schemas, DSL builders (`defineAgent`, `defineWorkflow`, `loop`, `sessionToken`) |
| [`@ageflow/executor`](packages/executor) | DAG executor, loop runner, session manager, HITL, budget tracker, preflight |
| [`@ageflow/runner-claude`](packages/runners/claude) | Claude CLI subprocess runner |
| [`@ageflow/runner-codex`](packages/runners/codex) | OpenAI Codex CLI subprocess runner |
| [`@ageflow/testing`](packages/testing) | Test harness — mock agents, inspect call counts, test workflows without API calls |
| [`@ageflow/cli`](packages/cli) | `agentwf` CLI — `run`, `validate`, `dry-run`, `init` |

## Examples

- [`examples/bug-fix-pipeline`](examples/bug-fix-pipeline) — Full pipeline: analyze → fix (loop with session) → summarize. Demonstrates loops, HITL, session sharing, and type-safe `CtxFor`.

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 (or Node.js ≥ 18)
- [`claude` CLI](https://github.com/anthropics/claude-code) for Claude agents
- [`codex` CLI](https://github.com/openai/codex) for Codex agents

## License

MIT
