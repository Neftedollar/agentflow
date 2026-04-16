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

## Using MCP servers

Pass MCP server configuration via `mcp.servers` on any `defineAgent` call. The
Codex runner emits `-c mcp_servers.<name>.command=...` overrides to the Codex
CLI — no external config file is required.

```ts
import { defineAgent, safePath } from "@ageflow/core";
import { z } from "zod";

const fileAgent = defineAgent({
  runner: "codex",
  model: "o4-mini",
  input: z.object({ query: z.string() }),
  output: z.object({ result: z.string() }),
  prompt: ({ query }) => query,
  mcp: {
    servers: [
      {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        // Allowlist — only these tools are exposed to the model
        tools: ["read_file", "list_directory"],
        // Refine — validate path args before forwarding to the server
        refine: {
          read_file: z.object({ path: safePath({ allowAbsolute: false }) }),
        },
        // ${env:VAR} is resolved at launch time by the executor
        env: { NODE_ENV: "${env:NODE_ENV}" },
      },
    ],
  },
});
```

**Allowlist** (`tools`): when set, the tool names are forwarded via
`-c mcp_servers.filesystem.enabled_tools=["read_file","list_directory"]`. Unlisted
tools are denied before they reach the model.

**Refine** (`refine`): a map of tool name → Zod schema. Arguments are validated
against the schema before the call is dispatched. Use `safePath()` to prevent
path traversal.

**Environment expansion** (`env`): values of the form `${env:VAR}` are replaced
with the corresponding process environment variable at launch time.

## License

MIT
