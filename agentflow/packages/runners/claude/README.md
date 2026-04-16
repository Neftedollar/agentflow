# @ageflow/runner-claude

[![npm](https://img.shields.io/npm/v/@ageflow/runner-claude)](https://www.npmjs.com/package/@ageflow/runner-claude)

Claude CLI runner for [ageflow](../../../README.md). Spawns the [`claude`](https://github.com/anthropics/claude-code) CLI as a subprocess and parses its JSON output.

## Install

```bash
bun add @ageflow/runner-claude
```

Requires the Claude CLI to be installed and authenticated:

```bash
npm install -g @anthropic-ai/claude-code
claude --version  # verify
```

## Usage

```ts
import { registerRunner } from "@ageflow/core";
import { ClaudeRunner } from "@ageflow/runner-claude";

registerRunner("claude", new ClaudeRunner());
```

Then use `runner: "claude"` in any `defineAgent` call:

```ts
const myAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",   // or "claude-opus-4-6", "claude-haiku-4-5"
  input: z.object({ prompt: z.string() }),
  output: z.object({ result: z.string() }),
  prompt: ({ prompt }) => prompt,
});
```

## Features

- **Session continuity** — when an agent uses `sessionToken`, the runner passes `--resume <session_id>` to the CLI, preserving conversation context across calls
- **HITL detection** — if Claude requests a tool the workflow hasn't approved, the runner surfaces a `HITLRequest` instead of throwing
- **Automatic retries** — handled by the executor; the runner itself is stateless per call
- **JSON output** — parses Claude's `--output-format json` JSONL stream, extracts the result line

## Supported models

Any model supported by your `claude` CLI version. Common values:

| Model | ID |
|---|---|
| Claude Sonnet 4.6 | `claude-sonnet-4-6` |
| Claude Opus 4.6 | `claude-opus-4-6` |
| Claude Haiku 4.5 | `claude-haiku-4-5` |

## Using MCP servers

Pass MCP server configuration via `mcp.servers` on any `defineAgent` call. The
Claude runner passes `--mcp-config` with inline JSON and `--strict-mcp-config`
to the Claude CLI — no external config file is required.

```ts
import { defineAgent, safePath } from "@ageflow/core";
import { z } from "zod";

const fileAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
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
          read_file: z.object({ path: safePath("/workspace") }),
        },
        // ${env:VAR} is resolved at launch time by the executor
        env: { NODE_ENV: "${env:NODE_ENV}" },
      },
    ],
  },
});
```

**Allowlist** (`tools`): when set, only the listed tools are passed to the CLI
via `--allowedTools mcp__filesystem__read_file` flags. Unlisted tools are
denied before they reach the model.

**Refine** (`refine`): a map of tool name → Zod schema. Arguments are validated
against the schema before the call is dispatched. Use `safePath()` to prevent
path traversal.

**Environment expansion** (`env`): values of the form `${env:VAR}` are replaced
with the corresponding process environment variable at launch time.

## License

MIT
