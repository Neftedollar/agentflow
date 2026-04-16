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

For Azure you must pass the `api-version` query param via the `headers` option
(see Configuration below).

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
    "api-version": "2024-02-01", // e.g. Azure api-version
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

## License

MIT
