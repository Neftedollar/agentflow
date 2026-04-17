# @ageflow/runner-api

[![npm](https://img.shields.io/npm/v/@ageflow/runner-api)](https://www.npmjs.com/package/@ageflow/runner-api)

OpenAI-compatible HTTP runner for [ageflow](../../../README.md). Talks to any
`/chat/completions` endpoint via `fetch()`. Supports multi-round tool calling
internally, pluggable session storage, and returns `ToolCallRecord[]` for
observability. Zero external dependencies.

## Install

```bash
bun add @ageflow/runner-api
```

## Quick start

```ts
import { registerRunner } from "@ageflow/core";
import { ApiRunner } from "@ageflow/runner-api";

registerRunner(
  "api",
  new ApiRunner({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY!,
    defaultModel: "gpt-4o-mini",
  }),
);
```

Then use `runner: "api"` in any `defineAgent` call:

```ts
import { defineAgent } from "@ageflow/core";
import { z } from "zod";

const summarize = defineAgent({
  runner: "api",
  model: "gpt-4o-mini",
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string() }),
  prompt: (i) =>
    `Summarize in one sentence as JSON {"summary": string}:\n\n${i.text}`,
});
```

## Provider compatibility

| Provider      | `baseUrl`                                                              |
|---------------|------------------------------------------------------------------------|
| OpenAI        | `https://api.openai.com/v1`                                            |
| Groq          | `https://api.groq.com/openai/v1`                                       |
| Together AI   | `https://api.together.xyz/v1`                                          |
| Ollama        | `http://localhost:11434/v1`                                            |
| vLLM          | `http://localhost:8000/v1`                                             |
| LM Studio     | `http://localhost:1234/v1`                                             |
| Azure OpenAI  | `https://<resource>.openai.azure.com/openai/deployments/<model>`      |

For Azure you must include `?api-version=...` directly in `baseUrl` — the runner
appends `/chat/completions` to `baseUrl` as a path segment and does not merge
query parameters separately. Do **not** pass `api-version` via `headers`; Azure
rejects requests where it appears only as a header.

Example: `baseUrl: "https://<resource>.openai.azure.com/openai/deployments/<model>?api-version=2024-02-01"`

## Configuration

```ts
new ApiRunner({
  // Required
  baseUrl: "https://api.openai.com/v1",  // trailing slash is stripped automatically
  apiKey: "sk-...",

  // Optional
  defaultModel: "gpt-4o-mini",   // used when spawn() args.model is not set
  tools: {                       // tool registry — see Tool calling below
    readFile: { description: "...", parameters: { ... }, execute: async (args) => ... },
  },
  sessionStore: myStore,         // custom SessionStore — see Session persistence below
  maxToolRounds: 10,             // max tool-call loops before MaxToolRoundsError (default 10)
  requestTimeout: 120_000,       // ms before AbortController fires (default 120 000)
  headers: {                     // extra headers forwarded on every request
    "x-custom-header": "value",  // e.g. custom tracing headers
  },
  fetch: myFetchImpl,            // injectable fetch (default: globalThis.fetch)
})
```

## Tool calling

Register tools that the model may invoke. The runner loops internally until
the model stops requesting tool calls or `maxToolRounds` is reached.

```ts
import { ApiRunner } from "@ageflow/runner-api";
import * as fs from "node:fs/promises";

const runner = new ApiRunner({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  tools: {
    readFile: {
      description: "Read the contents of a file from disk",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute file path" } },
        required: ["path"],
      },
      execute: async ({ path }) => {
        return await fs.readFile(String(path), "utf-8");
      },
    },
    writeFile: {
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      execute: async ({ path, content }) => {
        await fs.writeFile(String(path), String(content), "utf-8");
        return "ok";
      },
    },
  },
});

const result = await runner.spawn({
  prompt: "Read ./README.md and summarize it in one sentence.",
  tools: ["readFile"],            // subset of registered tools exposed to model
});

console.log(result.stdout);      // final model reply
console.log(result.toolCalls);   // ToolCallRecord[] — every tool invocation
```

## Session persistence

By default each `spawn()` call gets a fresh UUID session handle and messages
are stored in an `InMemorySessionStore` (lives for the lifetime of the
`ApiRunner` instance). Pass a `sessionHandle` to resume a conversation:

```ts
const first = await runner.spawn({ prompt: "My name is Alice." });
// first.sessionHandle === "some-uuid"

const second = await runner.spawn({
  prompt: "What is my name?",
  sessionHandle: first.sessionHandle,
});
// second.stdout === "Your name is Alice."
```

### Custom `SessionStore` (e.g. Redis)

```ts
import type { SessionStore } from "@ageflow/runner-api";
import type { ChatMessage } from "@ageflow/runner-api";
import { createClient } from "redis";

const redis = createClient();
await redis.connect();

const redisStore: SessionStore = {
  async get(handle) {
    const raw = await redis.get(`session:${handle}`);
    return raw ? (JSON.parse(raw) as ChatMessage[]) : undefined;
  },
  async set(handle, messages) {
    await redis.set(`session:${handle}`, JSON.stringify(messages), { EX: 3600 });
  },
};

const runner = new ApiRunner({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  sessionStore: redisStore,
});
```

## Observability

`RunnerSpawnResult.toolCalls` is a `ToolCallRecord[]` containing every tool
invocation made during the session:

```ts
const result = await runner.spawn({ prompt: "...", tools: ["readFile"] });

for (const call of result.toolCalls ?? []) {
  console.log(call.name);       // "readFile"
  console.log(call.args);       // { path: "./foo.ts" }
  console.log(call.result);     // "export const ..."
  console.log(call.durationMs); // 12
}
```

The executor passes `toolCalls` through to `TaskMetrics` / `ExecutionTrace`
when present, enabling end-to-end observability without extra instrumentation.

## Validation

`runner.validate()` hits `GET /models` and returns `{ ok, version?, error? }`.
Useful for health-checks and pre-flight guards:

```ts
const { ok, version, error } = await runner.validate();
if (!ok) throw new Error(`API runner not reachable: ${error}`);
console.log("First available model:", version);
```

## Error types

| Error class         | When thrown                                                       |
|---------------------|-------------------------------------------------------------------|
| `MaxToolRoundsError` | Tool-call loop exceeded `maxToolRounds`                          |
| `ApiRequestError`   | HTTP response was non-2xx                                         |
| `ToolNotFoundError` | Reserved — executor pre-flight; runner itself soft-errors unknown tools |

```ts
import { MaxToolRoundsError, ApiRequestError } from "@ageflow/runner-api";

try {
  await runner.spawn({ prompt: "loop forever", tools: ["infiniteTool"] });
} catch (err) {
  if (err instanceof MaxToolRoundsError) {
    console.error("Too many tool rounds:", err.message);
  }
}
```

## Using MCP servers

Pass MCP server configuration via `mcp.servers` on any `defineAgent` call. The
API runner spawns each server as a stdio subprocess via
`@modelcontextprotocol/sdk`. Tools are discovered at spawn time and registered
in the tool-loop under the fully-qualified name `mcp__<server>__<tool>`.

```ts
import { defineAgent, safePath } from "@ageflow/core";
import { z } from "zod";

const fileAgent = defineAgent({
  runner: "api",
  model: "gpt-4o-mini",
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
        // Keep this server alive across spawn() calls on the same runner instance
        reusePerRunner: true,
      },
    ],
  },
});
```

**Allowlist** (`tools`): when set, only the listed tools are added to the
tool-loop registry. Unlisted tools never reach the model, and a post-dispatch
guard rejects unexpected call attempts.

**Refine** (`refine`): a map of tool name → Zod schema. Arguments are validated
against the schema before the call is dispatched. Use `safePath()` to prevent
path traversal.

**Environment expansion** (`env`): values of the form `${env:VAR}` are replaced
with the corresponding process environment variable at launch time.

### `reusePerRunner` — server lifecycle pooling

By default each `spawn()` call starts its own MCP server subprocesses and stops
them when the call completes. Set `reusePerRunner: true` on a server to keep it
alive in a per-runner pool and reuse it across all `spawn()` calls on the same
`ApiRunner` instance. This avoids repeated cold-start overhead for servers that
are expensive to initialize.

```ts
// Server stays up across calls — warm on every spawn()
{ name: "filesystem", command: "npx", args: [...], reusePerRunner: true }
```

### `runner.shutdown()` — draining the pool

`runner.shutdown()` is **process-scoped** — it is called automatically by the
AgentFlow CLI (`agentwf run`) and the server's `close()` method at process exit.
You do not need to call it manually when using those entry points.

If you are using `ApiRunner` directly (outside the CLI or server), call
`shutdownAllRunners()` from `@ageflow/core` when your process exits:

```ts
import { shutdownAllRunners } from "@ageflow/core";

process.on("SIGTERM", async () => {
  await shutdownAllRunners();
  process.exit(0);
});
```

## API reference

### `new ApiRunner(config: ApiRunnerConfig)`

Creates a new runner instance. All config fields except `baseUrl` and `apiKey`
are optional.

### `runner.validate(): Promise<{ ok: boolean; version?: string; error?: string }>`

Checks connectivity by calling `GET /models`. Returns `ok: false` on any
error (network, 4xx, 5xx) — never throws.

### `runner.spawn(args: RunnerSpawnArgs): Promise<RunnerSpawnResult>`

Executes a prompt, optionally resuming a session, and loops until the model
produces a non-tool-call response. Returns `stdout` (final text), `sessionHandle`,
`tokensIn`, `tokensOut`, and `toolCalls`.

### `runner.shutdown(): Promise<void>`

Stops all pooled MCP server subprocesses (`reusePerRunner: true`) and clears
the pool. Per-spawn servers are already stopped by `spawn()` itself — only the
pool requires an explicit `shutdown()` call. Safe to call more than once.

## License

MIT
