# @ageflow/runner-codex

[![npm](https://img.shields.io/npm/v/@ageflow/runner-codex)](https://www.npmjs.com/package/@ageflow/runner-codex)

OpenAI Codex CLI runner for [ageflow](../../../README.md). Spawns the [`codex`](https://github.com/openai/codex) CLI as a subprocess and parses its event stream output.

## Install

```bash
bun add @ageflow/runner-codex
```

Requires the Codex CLI to be installed and authenticated:

```bash
npm install -g @openai/codex
codex --version  # verify
```

## Usage

```ts
import { registerRunner } from "@ageflow/core";
import { CodexRunner } from "@ageflow/runner-codex";

registerRunner("codex", new CodexRunner());
```

Then use `runner: "codex"` in any `defineAgent` call:

```ts
const codeAgent = defineAgent({
  runner: "codex",
  model: "o4-mini",   // or "o3"
  input: z.object({ task: z.string() }),
  output: z.object({ code: z.string() }),
  prompt: ({ task }) => `Write TypeScript code that: ${task}`,
});
```

## Features

- **Session continuity** — when an agent uses `sessionToken`, the runner passes `resume <thread_id>` to continue an existing Codex thread
- **Event stream parsing** — handles `thread.started`, `item.completed`, and `turn.completed` events from the Codex JSON stream
- **Token tracking** — extracts input/output token counts from `turn.completed` for budget tracking

## Supported models

Any model supported by your `codex` CLI version:

| Model | ID |
|---|---|
| o4-mini | `o4-mini` |
| o3 | `o3` |

## License

MIT
