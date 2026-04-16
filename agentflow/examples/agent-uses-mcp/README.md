# agent-uses-mcp

Dogfood example showing the **same** AgentFlow workflow config running under
three different runners — `api`, `claude`, and `codex` — with only the
`runner:` string changing.

The `audit` agent uses the
[`@modelcontextprotocol/server-filesystem`](https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem)
MCP server to list files under a directory.

---

## Quick start

```sh
# Install workspace deps (run from repo root once)
bun install

# Run with the OpenAI-compatible HTTP runner
bun run demo:api        # requires OPENAI_API_KEY (or OPENAI_BASE_URL + key)

# Run with the Claude CLI runner
bun run demo:claude     # requires `claude` in PATH + ANTHROPIC_API_KEY

# Run with the OpenAI Codex CLI runner
bun run demo:codex      # requires `codex` in PATH + OPENAI_API_KEY

# Offline demo — no credentials needed (api runner only, canned response)
AGENTFLOW_MOCK=1 bun run demo:api
```

---

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `demo:claude` | Passed to the `claude` CLI subprocess |
| `OPENAI_API_KEY` | `demo:api`, `demo:codex` | Passed to the API runner / `codex` CLI |
| `OPENAI_BASE_URL` | `demo:api` | Override endpoint (default: `https://api.openai.com/v1`) |
| `CODEX_HOME` | `demo:codex` | Codex config directory (optional) |
| `AGENTFLOW_MOCK` | `demo:api` | Set to `1` to use a canned fetch mock instead of a real API call |

---

## MCP server used

**`@modelcontextprotocol/server-filesystem`** — launched via `npx` on demand by
each runner that supports subprocess MCP servers.

The server exposes `read_file` and `list_directory` tools scoped to
`/tmp/workdir`. AgentFlow applies a `safePath()` Zod refinement on both tools'
`path` argument before the call is dispatched, blocking:

- path traversal (`../`)
- absolute paths
- home expansion (`~`)
- environment variable expansion (`$VAR`)

Only tools in the allowlist (`read_file`, `list_directory`) are forwarded to the
model — all others are filtered before reaching the prompt.

---

## Security notes

| Feature | What it does |
|---|---|
| `tools: ["read_file", "list_directory"]` | Tool allowlist — any tool not listed is denied before it reaches the model |
| `refine: { read_file: z.object({ path: safePath() }), ... }` | Per-argument Zod refinement run before each tool call; rejects traversal, absolute paths, env vars |
| `sanitizeInput: true` (default) | Strips prompt-injection patterns from upstream agent outputs before interpolation |
| Subprocess scoping | The filesystem server is started with `/tmp/workdir` as its root — it cannot serve files outside that directory |

---

## Tests

```sh
bun run test       # runs with createTestHarness — no real API or CLI calls
bun run typecheck  # must pass across all three runner variants
```
