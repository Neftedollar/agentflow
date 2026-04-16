# Agents Use MCP Servers — Design Spec

**Date:** 2026-04-16
**Status:** Draft
**Author:** Orchestrator (issue #19)

---

## 1. Context

AgentFlow is pursuing two orthogonal MCP integrations:

1. **ageflow AS MCP server** (#18): each workflow becomes an MCP tool
   hosted by `@ageflow/mcp-server`.
2. **ageflow USES MCP servers** (this spec, #19): agents *inside* a
   workflow call external MCP servers (filesystem, github, slack,
   postgres, fetch, browser, …) as tools during execution.

Independent, and they compose.

The DSL already reserves shape for this. From `packages/core/src/types.ts`:

```ts
export interface MCPConfig {
  readonly server: string;
  readonly args?: readonly string[];
  readonly autoStart?: boolean;
}

export interface AgentDef<I, O, R> { readonly mcps?: readonly MCPConfig[]; }
export interface RunnerSpawnArgs   { mcps?: readonly MCPConfig[]; }
```

The field is plumbed from `AgentDef` through the executor to
`RunnerSpawnArgs`, but **no runner currently consumes it** —
`claude-runner.ts`, `codex-runner.ts`, and `api-runner.ts` all ignore
`args.mcps`. This spec fills in that gap end-to-end and adds the fidelity
the issue asks for: tool filtering, workflow-level fallback, per-runner
integration, security boundary, session/auth, failure modes.

---

## 2. Goals

- **Natively wire MCP into agents.** `defineAgent({ mcp: { … } })` at
  the DSL; runners dispatch transparently.
- **No breaking runner contract.** Upgrade `RunnerSpawnArgs.mcps`
  additively; make each runner honour it.
- **Three runners, one DSL.** `claude`, `codex`, `api` accept the same
  `mcp` declaration. Differences live inside the runner.
- **Tool allowlisting per agent.** `servers[i].tools: string[]` subsets
  a shared server's exposed tools.
- **Security-first defaults.** `sanitizeInput` still guards ctx;
  MCP tool results still pass through the agent output Zod boundary;
  path args can be refined with `safePath()`.
- **Workflow-level fallback.** `defineWorkflow({ mcp: { servers } })`
  inherits to agents, with per-agent override/extend.

## 3. Non-goals

- **No ageflow-as-proxy for ageflow-internal capabilities.** Executor
  state, session registry, budget are not MCP-exposed to the agent.
  Separate design (v0.4+).
- **No transport other than stdio** in v0.2. HTTP/WS → v0.3+.
- **No cross-task MCP server lifetime.** Per-spawn by default; opt-in
  per-runner pool (§8). No cross-workflow sharing.
- **No automatic discovery** of user MCP configs (`~/.mcp`,
  `~/.claude.json`). Hermetic by default.
- **No dynamic per-prompt tool enabling.** Allowlists are static per
  agent (matches the existing static-value rule for `tools`, `skills`).
- **No MCP resources / prompts** in v0.2 — tools only.

---

## 4. Architecture — Direct delegate vs. proxy

The core decision for this spec.

### Decision: **mixed — direct delegate for CLI runners, proxy for API runner.**

| Runner | Strategy | Why |
|--------|----------|-----|
| `@ageflow/runner-claude` | **Direct delegate** via `--mcp-config` + `--strict-mcp-config` | Claude CLI natively supports MCP — we just render our `mcp` config to the JSON shape it expects. Zero extra code for tool loop, no extra processes under our control. |
| `@ageflow/runner-codex` | **Direct delegate** via `-c mcp_servers.<name>.command=…` config overrides | Codex has first-class MCP support (the `codex mcp` subcommand and `~/.codex/config.toml`). We synthesize per-spawn overrides; the CLI handles protocol. |
| `@ageflow/runner-api` | **Proxy / spawn** — ageflow launches MCP servers, converts tool schemas, drives the tool loop | OpenAI-compatible chat APIs have **no MCP support**. The runner already has its own `tool-loop.ts`; we extend it to include MCP-sourced tools alongside user-registered ones. |

### Justification

**CLI runners (Claude / Codex):** any proxy we write duplicates
functionality the CLI already ships — connection management, tool
discovery, elicitation, auth, sandbox, error translation. Our job is to
*translate the DSL into the CLI's native config* and get out of the way.

**API runner:** no choice. OpenAI/Groq/Ollama/etc. do not speak MCP —
they speak function calling with static tool schemas. The runner must:

1. Launch each declared MCP server (stdio subprocess).
2. Speak MCP JSON-RPC (`initialize`, `tools/list`).
3. Convert MCP tool schemas → OpenAI function schemas.
4. Route `tool_calls` to `tools/call`; non-MCP tools keep going through
   the existing registry.
5. Shut down on spawn completion (v0.2) or return to a per-runner pool.

Additive — plugs into the existing `tool-loop.ts` (§9).

**Rejected — proxy everywhere.** Uniform interface at the cost of the
CLI runners' mature MCP UX (elicitation, progress, auth), an extra hop,
and a hand-rolled MCP client shipped earlier than warranted. The mixed
strategy is strictly less code.

### Module layout

```
packages/
  core/
    src/types.ts              # UPDATED: MCPConfig shape (additive fields)
    src/builders.ts           # UPDATED: defineAgent({ mcp }), defineWorkflow({ mcp })
    src/schemas.ts            # UPDATED: McpServerConfigSchema (Zod)
  executor/
    src/resolve-mcp.ts        # NEW: merge workflow + agent MCP configs
  runners/
    claude/src/claude-runner.ts     # UPDATED: render --mcp-config JSON
    codex/src/codex-runner.ts       # UPDATED: render -c mcp_servers.* flags
    api/src/mcp-client.ts           # NEW: stdio MCP client
    api/src/mcp-tool-adapter.ts     # NEW: bridge MCP tools into tool-loop
    api/src/api-runner.ts           # UPDATED: wire mcp-client before spawn
```

Dependency graph unchanged except `runners/api` gains one internal
module; no new external deps for CLI runners. `runners/api` picks up
`@modelcontextprotocol/sdk` (TypeScript reference client) so we don't
hand-roll JSON-RPC.

---

## 5. DSL extension

### 5.1 Per-agent MCP config

```ts
import { defineAgent, safePath } from "@ageflow/core";
import { z } from "zod";

const deploymentAgent = defineAgent({
  runner: "claude",
  input: z.object({ repo: z.string(), sha: safePath() }),
  output: z.object({ url: z.string().url() }),
  mcp: {
    servers: [
      {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/workdir"],
        env: { NODE_OPTIONS: "--max-old-space-size=512" },
        // Allowlist: agent sees ONLY these tools from this server.
        tools: ["read_file", "list_directory"],
      },
      {
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" },   // explicit env capture
        // Omitted `tools:` → all tools exposed by the server are allowed.
      },
    ],
  },
  prompt: ({ repo, sha }) => `Deploy ${repo}@${sha}…`,
});
```

### 5.2 `McpServerConfig` shape

`MCPConfig` upgrades from the current v0.1 draft (`{ server, args, autoStart }`)
to a stricter, MCP-spec-aligned shape. The old fields are deprecated
aliases (`server` → `name`, `autoStart` unused in v0.2).

```ts
export interface McpServerConfig {
  /** Stable identifier, /^[a-zA-Z0-9._-]+$/. Used as tool-name prefix. */
  readonly name: string;
  /** Executable. Must be static; no function forms (matches skills/tools). */
  readonly command: string;
  readonly args?: readonly string[];
  /** Env vars. `${env:X}` substitution resolved at launch time. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory. Default: executor cwd. */
  readonly cwd?: string;
  /**
   * Tool allowlist. When omitted, all tools exposed by the server are
   * allowed. When present, tool names not in the list are filtered out
   * before reaching the model.
   */
  readonly tools?: readonly string[];
  /**
   * Per-tool argument refinement. Maps tool name → Zod schema run before
   * the call is dispatched. Lets users pin `safePath()` on path args.
   */
  readonly refine?: Readonly<Record<string, import("zod").ZodType>>;
  /** Transport — v0.2 only supports "stdio". Typed open for v0.3+. */
  readonly transport?: "stdio";
}

export interface AgentMcpConfig {
  readonly servers: readonly McpServerConfig[];
  /**
   * When `true`, this agent's `servers` are appended to the workflow's
   * (union, deduped by `name`). When `false` (default), agent replaces
   * workflow config. Explicit to avoid surprises.
   */
  readonly extendWorkflow?: boolean;
}

export interface AgentDef<I, O, R> {
  // …
  readonly mcp?: AgentMcpConfig;           // NEW (replaces `mcps`)
  /** @deprecated use `mcp.servers` */
  readonly mcps?: readonly McpServerConfig[];
}
```

### 5.3 Workflow-level fallback

```ts
const wf = defineWorkflow({
  name: "deploy",
  mcp: { servers: [fsServer, slackServer] },
  tasks: {
    plan:   task(plannerAgent),                              // inherits workflow MCP
    deploy: task(deployerAgent),                             // agent's own mcp overrides
    notify: task(notifierAgent, { mcpOverride: { servers: ["slack"] } }),
  },
});
```

`mcpOverride` on a task is a whitelist by server name — "take the
resolved list, keep only these".

### 5.4 Resolution rules (`executor/src/resolve-mcp.ts`)

1. Start with `workflow.mcp?.servers ?? []`.
2. Agent has `mcp.extendWorkflow === true` → append agent servers
   (dedup by name; agent wins). Else if agent provides `mcp` →
   **replace** entirely.
3. Task `mcpOverride.servers: string[]` → keep only those names.
4. Per-server `tools` allowlist applied at dispatch time (§6).

Pre-flight catches: duplicate names, non-static `command`/`args`,
unknown name in `mcpOverride`.

---

## 6. Tool filtering & allowlist enforcement

Two layers of filtering, both mandatory:

### 6.1 Pre-dispatch filtering (before model sees tools)

After `tools/list`, the runner (CLI or API) filters the MCP tool list by
`server.tools` if present. The model never sees non-allowlisted tools.
This is the primary defence: the model can't ask for what it doesn't
know exists.

### 6.2 Post-dispatch enforcement (before executing the call)

When a tool call arrives, the runner checks `tool.name` against the
allowlist *again*. Mismatch → synthetic tool error
`TOOL_NOT_PERMITTED: <server>/<tool>` returned to the model, *not* to
the MCP server. This catches tool-name spoofing and defends against a
compromised server re-announcing tools.

### 6.3 Tool naming

All MCP tools are namespaced to avoid collisions with user-registered
tools and between MCP servers:

```
mcp_<server_name>__<tool_name>
```

Example: `mcp_filesystem__read_file`. This matches Claude CLI's
existing convention (it prefixes MCP tools identically) so a user who
debugged their Claude CLI MCP setup sees the same names in AgentFlow
logs.

For the Claude/Codex runners the namespacing is done by the CLI itself;
we don't touch it. For the API runner we apply the convention in
`mcp-tool-adapter.ts` when converting MCP schemas → OpenAI function
schemas.

### 6.4 Interaction with `sanitizeInput` and `safePath`

- **`sanitizeInput`** (default `true`): governs whether `ctx.*.output`
  is stripped of injection patterns before prompt interpolation.
  Unchanged by this spec. MCP tool *arguments* flow model → server and
  do **not** touch `sanitizeInput` — they can contain anything the
  model generated.
- **`safePath()`**: optional per-server `refine` map gives users a
  place to enforce path discipline on MCP tool args:

  ```ts
  mcp: {
    servers: [{
      name: "filesystem",
      command: "…",
      refine: {
        read_file:    z.object({ path: safePath({ root: "/tmp/workdir" }) }),
        list_directory: z.object({ path: safePath({ root: "/tmp/workdir" }) }),
      },
    }],
  }
  ```

  On a failing refine, the call is rejected with
  `TOOL_ARG_VALIDATION_FAILED`, returned to the model as a tool error
  message. The model gets to retry; the MCP server is never asked.

---

## 7. Security boundary

**Trust zones:** executor (trusted) → agent LLM (untrusted) → MCP server
(untrusted) → MCP tool result (untrusted).

**Five invariants:**

1. **Zod is still the only boundary.** MCP tool results stay inside the
   runner's tool loop. They influence the model's next turn, but the
   agent's final `stdout` still passes through `agent.output.parse()`
   before any downstream task sees it.
2. **Allowlist is double-enforced** (§6.1 + §6.2).
3. **Path-like args get `safePath` refinement** when declared. Runs
   *inside the runner*, not the server.
4. **Env-var substitution is explicit.** `"${env:GITHUB_TOKEN}"` is the
   only way to pass secrets; bare envs are not inherited unless the
   agent's `env.pass` list allows them.
5. **MCP stderr is captured, not forwarded to the model.** Teed to the
   executor logger; never enters the prompt.

---

## 8. Session / auth for stateful MCP servers

MCP servers are frequently stateful (OAuth github, logged-in slack,
postgres connection). AgentFlow's `SessionToken` is **independent** of
the MCP server's session — not 1:1, not branded onto MCP.

**Lifecycle policy for v0.2:**

- **CLI runners.** The CLI owns MCP server lifecycle — our config is
  rendered into `--mcp-config` / `-c mcp_servers.*`; the CLI launches
  fresh per invocation. Servers caching auth on disk (keychain) benefit
  naturally; in-memory cross-call state does **not** persist — documented
  limitation.
- **API runner.** Per-spawn by default. Opt-in pool
  (`reusePerRunner: true` on `McpServerConfig`) keeps the process alive
  across `spawn()` calls on the same `ApiRunner`. Pool lifetime = runner
  lifetime; drained by `runner.shutdown()` (§9.4).

**Auth.** OAuth/PAT via `env` + `${env:…}`. AgentFlow never stores
tokens. Secret store is a future spec.

**Correlation with AgentFlow `SessionToken`.** Resuming
`SessionToken<"claude">` does not resume MCP server state. Matches
Claude CLI behaviour today.

---

## 9. Per-runner integration

### 9.1 `claude-runner` — `--mcp-config`

Claude CLI accepts JSON strings via `--mcp-config <configs…>` plus
`--strict-mcp-config` to ignore user-level configs. JSON shape:

```json
{ "mcpServers": { "filesystem": { "command": "npx", "args": [...], "env": {...} } } }
```

Rendering in `claude-runner.ts::spawn()`:

1. Empty `args.mcpServers` → unchanged code path.
2. Build `{ mcpServers: { … } }` from the resolved list; resolve
   `${env:X}` from `process.env`.
3. Pass as inline JSON string to `--mcp-config` (no temp file).
4. Always emit `--strict-mcp-config` — hermetic by default.
5. For each `McpServerConfig.tools` entry, append
   `mcp__<server>__<tool>` to `--allowedTools`; all other MCP tools go
   to `--disallowedTools`.

### 9.2 `codex-runner` — `-c mcp_servers.*`

Codex merges `mcp_servers` from `~/.codex/config.toml` with
per-invocation `-c` overrides. To stay hermetic we push one `-c` per
field:

```
codex exec --json \
  -c mcp_servers.filesystem.command=npx \
  -c 'mcp_servers.filesystem.args=["-y","@modelcontextprotocol/server-filesystem","/tmp"]' \
  -c 'mcp_servers.filesystem.env={FOO="bar"}' \
  "<prompt>"
```

Helper `renderCodexMcpFlags(servers)`. Tool filter rendered as
`mcp_servers.<n>.tools` TOML array. Codex has no `--strict` flag yet;
users needing full isolation set `CODEX_HOME` to a scratch dir via
`env.pass`.

### 9.3 `api-runner` — spawn + MCP client

New modules under `packages/runners/api/src/`:

- `mcp-client.ts` — wraps `@modelcontextprotocol/sdk`
  (`StdioClientTransport` + `Client`). Interface:
  `start() → McpToolDescriptor[]`, `call(name, args) → unknown`,
  `stop()`. One client per `McpServerConfig`.
- `mcp-tool-adapter.ts` — `mcpToolsToRegistry(clients, descriptors)
  → ToolRegistry`. Each `execute()` forwards to the right client and
  applies `refine` if present. Name mangling: `mcp_<server>__<tool>`.

Integration into `api-runner.ts::spawn()`:

```ts
const mcpClients = await startMcpClients(args.mcpServers ?? []);
const mcpRegistry = await mcpToolsToRegistry(mcpClients);
const merged = { ...this.tools, ...mcpRegistry };
try {
  const loop = await runToolLoop({ …, registry: merged,
    tools: toolsToSchemas(merged, args.tools) });
  return { stdout: loop.finalText, … };
} finally {
  if (!this.reusePool) await shutdownAll(mcpClients);
}
```

### 9.4 `Runner.shutdown()` (new optional method)

```ts
export interface Runner {
  validate(): Promise<…>;
  spawn(args: RunnerSpawnArgs): Promise<RunnerSpawnResult>;
  shutdown?(): Promise<void>;                 // NEW, optional
}
```

CLI runners: no-op. API runner: drains the MCP pool. Executor invokes
on process exit / explicit CLI shutdown.

---

## 10. Error handling

New error codes (added to the core `AgentFlowError` hierarchy):

```ts
export const AgentFlowErrorCode = {
  // … existing
  MCP_SERVER_START_FAILED:    "mcp_server_start_failed",
  MCP_SERVER_CRASHED:         "mcp_server_crashed",
  MCP_TOOL_NOT_FOUND:         "mcp_tool_not_found",
  MCP_TOOL_NOT_PERMITTED:     "mcp_tool_not_permitted",
  MCP_TOOL_ARG_INVALID:       "mcp_tool_arg_invalid",
  MCP_TOOL_CALL_FAILED:       "mcp_tool_call_failed",
  MCP_PROTOCOL_ERROR:         "mcp_protocol_error",
  MCP_TIMEOUT:                "mcp_timeout",
} as const;
```

Mapping per failure mode:

| Failure                                         | Surfaces where                               | Code                     |
|-------------------------------------------------|----------------------------------------------|--------------------------|
| Command not on PATH at launch                   | `spawn()` reject → task retry / fail         | `MCP_SERVER_START_FAILED`|
| Non-zero exit during `initialize`               | `spawn()` reject                             | `MCP_SERVER_START_FAILED`|
| Stdout not valid JSON-RPC                       | `spawn()` reject                             | `MCP_PROTOCOL_ERROR`     |
| Server exits mid-`tools/call`                   | Tool call result → model sees error message  | `MCP_SERVER_CRASHED`     |
| Model calls allowlisted-out tool                | Tool result → model                          | `MCP_TOOL_NOT_PERMITTED` |
| Model calls unknown tool                        | Tool result → model                          | `MCP_TOOL_NOT_FOUND`     |
| `refine` schema rejects args                    | Tool result → model                          | `MCP_TOOL_ARG_INVALID`   |
| MCP server returns `isError: true`              | Tool result → model                          | `MCP_TOOL_CALL_FAILED`   |
| `tools/call` exceeds `mcpCallTimeoutMs`         | Tool result → model, server force-killed     | `MCP_TIMEOUT`            |

Distinction matters: startup failures are **task-level** errors (the
agent never ran); in-loop failures are **tool-level** (model gets a
chance to recover). Today's executor retry rules for
`subprocess_error` are extended so `mcp_server_start_failed` is
retriable by default (same class — transient). `mcp_server_crashed`
mid-turn is **not** retriable at task level — the tool-call message
already informs the model.

For CLI runners, most of these surface as CLI stderr + exit codes,
which the existing `ClaudeSubprocessError` / `CodexSubprocessError`
handlers cover. Pre-flight (§11) upgrades stderr patterns to map
`MCP server "foo" failed to start` lines to `MCP_SERVER_START_FAILED`.

### 10.1 Server disconnects / hangs

- **Per-call timeout:** `mcpCallTimeoutMs` on `McpServerConfig`
  (default 30 s). Runner races `tools/call` against the timeout. On
  timeout: abort the JSON-RPC request, kill the server (`SIGTERM` then
  `SIGKILL` after 5 s), return `MCP_TIMEOUT` to the model, launch a
  replacement on next call.
- **Stderr watchdog:** runner tees server stderr to the executor
  logger; non-zero rate of `ERROR` lines is surfaced but not fatal.

---

## 11. Testing strategy

**Unit (no subprocess):**
- `resolveMcp(workflow, agent, task)` — all extend/replace/override
  combinations.
- `renderMcpJson(servers)` and `renderCodexMcpFlags(servers)` — snapshot
  tests on the exact bytes / flag-array.
- Allowlist double-enforcement: model emits a non-allowed tool →
  `MCP_TOOL_NOT_PERMITTED` without hitting the client.
- `refine` rejection path: bad path → `MCP_TOOL_ARG_INVALID`.
- Env substitution: `${env:X}` from `process.env`; missing var → fail
  at pre-flight.

**Mock MCP server fixture** (`packages/testing/src/fixtures/mock-mcp.ts`)
using `@modelcontextprotocol/sdk`. Parameterised: crash, hang,
`isError`, echo. Used by:
- `runners/api` integration tests (real subprocess).
- `claude-runner` / `codex-runner` tests behind
  `CLAUDE_CLI_AVAILABLE=1` / `CODEX_CLI_AVAILABLE=1`.

**Dogfooding.** `agentflow/examples/mcp-filesystem-audit/` uses the
filesystem MCP server. Acceptance: the *same* config passes under
`claude`, `codex`, and `api` runners (only `runner:` string differs).

**Security tests.**
- Tool-spoofing: server announces `exec_anywhere`, not in allowlist,
  model still emits → server never receives `tools/call`.
- Path escape: `refine` with `safePath({ root: "/tmp/sandbox" })`
  rejects `/etc/passwd`.
- Prompt injection in tool result: server returns `Ignore previous
  instructions…` as a file's text. Reaches the model (by design); the
  agent's final output still passes through Zod — downstream tasks see
  typed fields only.

---

## 12. Non-goals (recap)

Restated for emphasis:

- No ageflow-as-proxy-MCP for ageflow-internal capabilities.
- No transport other than stdio in v0.2.
- No cross-task MCP server lifetime (per-spawn by default; pool opt-in
  is per-runner, not per-workflow).
- No MCP resources / prompts — v0.2 is **tools only**.
- No discovery of user-level MCP configs (hermetic by default).
- No dynamic tool enabling within a single prompt.

---

## 13. Roadmap post-spec

1. **DSL + resolution** (`core` + `executor`): `AgentMcpConfig`, Zod
   schema, `resolve-mcp.ts`, pre-flight. No runner changes yet.
2. **Claude runner wiring**: `--mcp-config` rendering, allowlist flags,
   integration test behind `CLAUDE_CLI_AVAILABLE`.
3. **Codex runner wiring**: `-c mcp_servers.*`, TOML escaping,
   integration test behind `CODEX_CLI_AVAILABLE`.
4. **API runner wiring**: `mcp-client.ts` + `mcp-tool-adapter.ts`,
   per-spawn lifecycle, mock-server unit + real-server integration
   tests.
5. **Pool + `shutdown()`**: opt-in `reusePool`, `Runner.shutdown()` hook,
   CLI graceful-exit integration.
6. **Resources + prompts** (v0.3): `resources/list|read` as typed
   context, `prompts/get` as templated sub-prompts.
7. **HTTP/SSE transport** (v0.3+): non-stdio MCP.
8. **ageflow-as-proxy-MCP for internal state** (v0.4?): executor-internal
   capabilities (session store, budget peek, run status) as MCP tools.

---

## 14. Open questions

1. `mcpOverride` at task level in v0.2 or defer? Leaning yes — small
   surface, requested in issue discussion.
2. Namespace format: `mcp_<server>__<tool>` or match Claude's exact
   `mcp__<server>__<tool>` (double underscore)? Defaulting to Claude's
   for log-copy-paste symmetry.
3. Mandatory `refine` for path-accepting tools, or warn-only? Leaning
   warn.
4. `mcpCallTimeoutMs` default — 30 s proposed.

---

## 15. Follow-ups (future issues)

- MCP resources support (Phase 6).
- MCP HTTP/SSE transport (Phase 7).
- Secret store integration beyond `${env:…}`.
- MCP elicitation forwarding into AgentFlow HITL.
- Per-workflow MCP pool (vs. per-runner).
- `ageflow.json` declarative config — import Claude-Desktop MCP lists
  without edits.
