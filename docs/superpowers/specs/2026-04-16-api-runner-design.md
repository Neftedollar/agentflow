# AgentFlow API Runner — Design Spec

**Date:** 2026-04-16  
**Status:** Draft

---

## Context

AgentFlow currently has two runners — Claude and Codex — both subprocess-based (spawn a CLI tool). This limits AgentFlow to models that have a local CLI. This spec adds `@agentflow/runners-api` — a runner that calls any OpenAI-compatible API endpoint directly via `fetch()`, enabling use with OpenAI, Groq, Together, vLLM, Ollama, LM Studio, and any server speaking the OpenAI chat completions protocol.

The runner implements the existing `Runner` interface with zero changes to the executor. It handles tool calling internally (multi-round tool loop) and exposes structured `ToolCallRecord`s for observability via the `ExecutionTrace` system from the learning spec.

---

## Design Goals

- **Zero vendor lock-in** — pure OpenAI-compatible protocol, no SDK dependency, just `fetch()`
- **Zero executor changes** — implements existing `Runner` interface
- **Tool loop encapsulated** — runner manages tool call → execute → respond cycles internally
- **Pluggable session store** — in-memory by default, injectable for Redis/SQLite
- **Observable** — `ToolCallRecord[]` returned in `RunnerSpawnResult` for tracing

---

## Architecture

### New package

```
packages/runners/api/
├── src/
│   ├── index.ts              — public exports
│   ├── api-runner.ts         — Runner implementation
│   ├── tool-loop.ts          — tool call → execute → respond cycle
│   ├── session-store.ts      — SessionStore interface + InMemorySessionStore
│   ├── openai-types.ts       — OpenAI chat completion request/response types
│   └── message-builder.ts    — builds messages[] from prompt + session history
```

### Dependency graph

```
core ← runners/api    (new — zero external deps)
core ← runners/claude
core ← runners/codex
```

### `package.json`

```json
{
  "name": "@agentflow/runners-api",
  "dependencies": {
    "@agentflow/core": "workspace:*"
  }
}
```

Zero external dependencies. Uses only `fetch()` and `crypto.randomUUID()` (both built-in to Node.js and Bun).

---

## `@agentflow/core` Change

One additive, backward-compatible change to `RunnerSpawnResult`:

```ts
interface RunnerSpawnResult {
  readonly stdout: string;
  readonly sessionHandle: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly toolCalls?: readonly ToolCallRecord[];  // new, optional
}

type ToolCallRecord = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
};
```

Existing runners (claude, codex) return `undefined` for `toolCalls` — no impact. The executor passes `toolCalls` through to `ExecutionTrace` (when the learning package is present).

---

## `ApiRunnerConfig`

```ts
type ApiRunnerConfig = {
  baseUrl: string;                      // e.g. "https://api.openai.com/v1"
  apiKey: string;
  defaultModel?: string;                // fallback if agent.model not set
  tools?: ToolRegistry;                 // available tools for this runner
  sessionStore?: SessionStore;          // default: InMemorySessionStore
  maxToolRounds?: number;               // default: 10
  requestTimeout?: number;              // per API call, ms, default: 120_000
  headers?: Record<string, string>;     // custom headers for proxies (Helicone, Portkey)
};
```

### Registration

```ts
import { registerRunner } from "@agentflow/core";
import { ApiRunner } from "@agentflow/runners-api";

registerRunner("api", new ApiRunner({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: "gpt-4o",
  tools: {
    readFile: {
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async ({ path }) => Bun.file(path as string).text(),
    },
  },
}));
```

### Usage in workflow

```ts
const analyzer = defineAgent({
  runner: "api",
  model: "gpt-4o",       // overrides defaultModel
  input: z.object({ code: z.string() }),
  output: z.object({ issues: z.array(z.string()) }),
  prompt: (i) => `Analyze this code:\n${i.code}`,
});
```

---

## Tool Loop

### Flow

```
spawn(args) called
  ↓
Load session history from SessionStore (or start empty)
  ↓
Build messages[]:
  - system message (args.systemPrompt, if present)
  - ...session history
  - user message (args.prompt)
  ↓
Filter tools: args.tools (string names) → lookup in ToolRegistry → tool definitions
  ↓
POST /chat/completions { model, messages, tools }
  ↓
Response has tool_calls?
  ├─ no  → done, return assistant content as stdout
  └─ yes → for each tool_call:
             - look up tool in registry
             - execute(args) → result
             - record ToolCallRecord { name, args, result, durationMs }
             - append tool result message
           ↓
         POST /chat/completions again (with updated messages)
           ↓
         Repeat until no more tool_calls
         or maxToolRounds exceeded → throw MaxToolRoundsError
  ↓
Save full messages[] to SessionStore under sessionHandle
  ↓
Return {
  stdout: final assistant message content,
  sessionHandle,
  tokensIn: sum of all rounds,
  tokensOut: sum of all rounds,
  toolCalls: all ToolCallRecord[]
}
```

### Safety

- `maxToolRounds` (default: 10) prevents infinite tool loops
- `requestTimeout` (default: 120s) per individual API call
- Tools that throw are caught — error message sent back to model as tool result

---

## Session Management

### `SessionStore` interface

```ts
interface SessionStore {
  get(handle: string): Promise<Message[] | undefined>;
  set(handle: string, messages: Message[]): Promise<void>;
  delete(handle: string): Promise<void>;
}
```

### `InMemorySessionStore`

Default implementation — `Map<string, Message[]>`. Suitable for single-process servers and CLI usage. Lost on process restart.

### Session flow inside `spawn()`

```ts
// Resume or start new
const history = args.sessionHandle
  ? await this.sessionStore.get(args.sessionHandle) ?? []
  : [];

const sessionHandle = args.sessionHandle ?? crypto.randomUUID();

// ... build messages, run tool loop ...

await this.sessionStore.set(sessionHandle, updatedMessages);

return { stdout, sessionHandle, tokensIn, tokensOut, toolCalls };
```

### Custom stores

Users can implement `SessionStore` for Redis, SQLite, or any other backend:

```ts
registerRunner("api", new ApiRunner({
  baseUrl: "...",
  apiKey: "...",
  sessionStore: new RedisSessionStore({ url: process.env.REDIS_URL }),
}));
```

---

## Token Accounting

Each API call returns `usage.prompt_tokens` and `usage.completion_tokens`. Multi-round tool loops sum across all roundtrips:

```ts
let totalTokensIn = 0;
let totalTokensOut = 0;

for (const round of rounds) {
  totalTokensIn += round.usage.prompt_tokens;
  totalTokensOut += round.usage.completion_tokens;
}
```

This feeds into executor's `TaskMetrics` and `BudgetTracker` without changes.

---

## `validate()`

```ts
async validate(): Promise<{ ok: boolean; version?: string; error?: string }> {
  // GET {baseUrl}/models with Authorization header
  // Success → { ok: true, version: firstModelId }
  // Auth failure → { ok: false, error: "401 Unauthorized" }
  // Network error → { ok: false, error: message }
}
```

Pre-flight validation catches bad `baseUrl` or `apiKey` before any workflow runs.

---

## OpenAI Protocol Types

Minimal type definitions for the chat completions API (in `openai-types.ts`):

```ts
type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };  // JSON string
};

type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  max_tokens?: number;
};

type ChatCompletionResponse = {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};
```

These are the subset of the OpenAI protocol needed — no full SDK import.

---

## Public API

```ts
// packages/runners/api/src/index.ts
export { ApiRunner } from "./api-runner";
export { InMemorySessionStore } from "./session-store";
export type {
  ApiRunnerConfig,
  SessionStore,
  ToolRegistry,
  ToolDefinition,
  ToolCallRecord,
} from "./types";
```

---

## Provider Compatibility

Any server that implements POST `/chat/completions` with the standard request/response format:

| Provider | baseUrl | Notes |
|----------|---------|-------|
| OpenAI | `https://api.openai.com/v1` | |
| Groq | `https://api.groq.com/openai/v1` | |
| Together | `https://api.together.xyz/v1` | |
| Ollama | `http://localhost:11434/v1` | Local |
| vLLM | `http://localhost:8000/v1` | Local |
| LM Studio | `http://localhost:1234/v1` | Local |
| Azure OpenAI | `https://{name}.openai.azure.com/openai/deployments/{dep}` | Needs `api-version` header |
| Anthropic | Not compatible | Use `@agentflow/runners/claude` instead |

---

## Verification

1. **Unit tests** — mock `fetch()`, test:
   - Simple prompt → text response
   - Multi-round tool loop (2-3 rounds)
   - `maxToolRounds` exceeded → error
   - Session resume (get → update → get)
   - Token accumulation across rounds
   - `validate()` success and failure cases

2. **Integration test** — real API call (behind env flag):
   - `AGENTFLOW_TEST_API_URL` + `AGENTFLOW_TEST_API_KEY`
   - Simple completion + tool call round

3. **Backward compat** — `ToolCallRecord` on `RunnerSpawnResult` is optional; existing runner tests pass unchanged

4. **Cross-provider** — test with at least OpenAI and Ollama URLs

---

## Out of scope

- Streaming API responses (runner returns buffered result, like claude/codex runners)
- Retry/backoff on API errors (executor handles retry at task level)
- Structured output / JSON mode (`response_format`) — can be added later
- Vision / multimodal messages
