# MCP Job-Based Async Execution — Design Spec

**Date:** 2026-04-16
**Status:** Draft
**Author:** Orchestrator (issue #18)

---

## Context

`@ageflow/mcp-server` exposes a single ageflow workflow as one MCP tool
with **synchronous streaming** semantics: the client holds the JSON-RPC
request open, receives `notifications/progress` events, and eventually the
tool result. Concurrency is gated by an `inflight` boolean (`BUSY` error
on a second call).

Two shapes break this model:

1. **Clients without `notifications/progress`.** A 15-minute workflow is
   indistinguishable from a hang.
2. **Fire-and-forget / reconnect.** JSON-RPC's request/response cannot
   express "start now, poll later, reconnect from another client".

Issue #18 proposes a **job mode**: opt-in extra MCP tools that separate
"start a run" from "observe a run". Sync streaming stays the default.

Meanwhile, #26 shipped `@ageflow/server` with `RunHandle`, `RunRegistry`,
`Runner.fire()` / `resume()` / `cancel()`, TTL sweeping, and async-HITL via
deferred resolution — exactly the primitives job mode needs. This spec
decides how to reuse them and what the MCP tool surface looks like.

---

## Goals

- **Sync mode stays the default.** No flag, no change, no new tools. Today's
  behaviour is preserved byte-for-byte.
- **Async mode is opt-in** via a server flag (`async: true` /
  `--async` on the CLI). When off, no job tools appear in `listTools`.
- **Reuse `@ageflow/server`.** Do not duplicate `RunHandle` / `RunRegistry`
  in `@ageflow/mcp-server`. The async path delegates to `createRunner()`.
- **One workflow, two surfaces.** In async mode the same workflow is
  reachable via the sync tool (`<workflow>`) **and** four job tools
  (`start_<workflow>`, `get_workflow_status`, `get_workflow_result`,
  `cancel_workflow`).
- **Async HITL has a story.** In sync mode, elicitation uses MCP
  progress/elicitation as today. In job mode, elicitation surfaces via
  `get_workflow_status.currentTask` — no out-of-band prompt because the
  originating client may be gone.
- **Job registry defaults to in-process, with optional persistence.**
  By default jobs use an in-memory store. With `--job-db <path>` the
  registry persists snapshots to SQLite and hydrates known jobs on startup.

## Non-goals

- **No distributed jobs.** `jobId` is valid only on the server that created
  it. Horizontal scale requires sticky routing — out of scope.
- **No distributed persistence / replication.** Durable snapshots are local
  to a single server instance (for example SQLite on local disk).
- **No job prioritization / queueing.** Single-run `BUSY` lock preserved
  (§5). First caller wins; second caller gets `BUSY`.
- **No new HITL mechanism.** Existing `hitl-bridge`; only **surfacing**
  differs in job mode.
- **No bulk job APIs.** No `list_jobs`, no `wait_for_job`.
- **No auth / multi-tenancy.** MCP's transport auth is the only boundary.

---

## Architecture

### Mode selection

```ts
// packages/mcp-server/src/server.ts
export interface McpServerOptions {
  readonly workflow: WorkflowDef;
  readonly cliCeilings: CliCeilings;
  readonly hitlStrategy: HitlStrategy;
  /** NEW — opt-in async mode. Default: false. */
  readonly async?: boolean;
  /** NEW — override registry TTLs (forwarded to createRunner). */
  readonly jobTtlMs?: number;
  readonly jobCheckpointTtlMs?: number;
  readonly stderr?: (line: string) => void;
  readonly runWorkflow?: RunWorkflowFn;
}
```

When `async === true`:
1. `listTools()` returns **5** tools: the existing sync tool +
   `start_<workflow>`, `get_workflow_status`, `get_workflow_result`,
   `cancel_workflow`.
2. A `Runner` from `@ageflow/server` is lazily created on first
   `start_*` call and held for the server's lifetime.
3. `callTool(<workflow>, …)` (sync path) and `callTool(start_<workflow>, …)`
   (async path) share the same inflight lock (§5).

When `async === false` (default), behaviour is unchanged from today.

### Why reuse `@ageflow/server` (not duplicate)

**Decision: reuse.**

| Capability needed by job mode                     | `@ageflow/server` already has it? |
|---------------------------------------------------|-----------------------------------|
| Assign a `runId`, return synchronously            | Yes — `Runner.fire()`             |
| In-memory registry with TTL GC                    | Yes — `RunRegistry`               |
| Poll state (`running` / `awaiting-checkpoint` / …)| Yes — `Runner.get(runId)`         |
| Final result when `done`                          | Yes — `RunHandle.result`          |
| Cancel in-flight                                  | Yes — `Runner.cancel(runId)`      |
| Async HITL (suspend + resume)                     | Yes — `Runner.resume(runId, …)`   |
| Abort propagation                                 | Yes — `AbortController` plumbing  |
| Checkpoint auto-reject on TTL                     | Yes — `checkpointTtlMs`           |

Duplicating would mean re-implementing `RunRegistry`, `RunHandle`, the
reaper, and deferred checkpoint resolution — all non-trivial and already
battle-tested in `packages/server`. Rejected alternative: inline a simpler
`JobRegistry` that skips HITL — async HITL is the hardest piece of #18 and
`@ageflow/server` solves it for free.

Dependency shape: `mcp-server → {core, executor, server}`. No cycle
(`server → {core, executor}`). New files: `job-tools.ts` (builds 5
`ToolDefinition`s) and `job-dispatch.ts` (callTool handlers).

### Interaction with the existing sync tool

Shared: input schema (same Zod → JSON Schema); inflight `BUSY` lock;
ceilings (`composeCeilings`); `hitlStrategy`.

Differ: progress (sync emits `notifications/progress` on the open call;
async ignores `progressToken` and surfaces progress via
`get_workflow_status`); output (sync returns validated output inline;
async returns `{ jobId }`, output arrives via `get_workflow_result`).

---

## 4. Tool signatures

### Sync tool (unchanged)

```
name:          <workflow.name>
input:         <workflow input Zod → JSON Schema>
output:        <workflow output Zod → JSON Schema>
errors:        McpToolErrorResult with ErrorCode.*
```

### `start_<workflow>`

```jsonc
{
  "name": "start_<workflow.name>",
  "description": "Start <workflow.name> asynchronously. Returns a jobId.",
  "inputSchema": <same as sync tool>,
  "outputSchema": {
    "type": "object",
    "required": ["jobId"],
    "properties": {
      "jobId": { "type": "string", "description": "UUID for polling" }
    }
  }
}
```

Semantics:
- Validates input against the workflow's input-task Zod schema (reuses
  `buildToolDefinition` output).
- Calls `runner.fire(workflow, input, { onCheckpoint })`, receives a
  `RunHandle`, returns `{ jobId: handle.runId }`.
- On validation failure returns `INPUT_VALIDATION_FAILED` (same as sync).
- On `BUSY` (another run inflight) returns `BUSY`.

### `get_workflow_status`

```
input:  { jobId: string }
output: { state, currentTask?, progress?, createdAt, lastEventAt }
  state:       RunState (running | awaiting-checkpoint | done | failed | cancelled)
  currentTask: { name, kind: "task" | "checkpoint", message? }
  progress:    { tasksCompleted, tasksTotal, spentUsd?, limitUsd? }
```

Semantics: `runner.get(jobId)`, missing → `JOB_NOT_FOUND`. `state` mirrors
`RunHandle.state`. `currentTask` is `{ kind: "checkpoint", name, message }`
when `awaiting-checkpoint`, else the last `task:start` (from the event
recorder, §5). `progress` counts `task:complete` events vs. workflow task
count, plus last `budget:warning` values.

### `get_workflow_result`

```
input:  { jobId: string }
output: { pending: true }  |  { state: "done", output: <workflow output>, metrics }
```

Semantics:
- `running` / `awaiting-checkpoint` → `{ pending: true }`.
- `done` → re-validates `handle.result.outputs[outputTaskName]` through the
  output Zod schema (mirrors sync tool's `OUTPUT_VALIDATION_FAILED` path).
- `failed` → `WORKFLOW_FAILED` error carrying `handle.error`.
- `cancelled` → `JOB_CANCELLED` error.
- Missing → `JOB_NOT_FOUND`.

### `cancel_workflow`

```
input:  { jobId: string }
output: { cancelled: boolean, priorState: RunState }
```

Semantics: missing → `JOB_NOT_FOUND`. Already terminal → `{ cancelled:
false, priorState }` (idempotent, not an error). Otherwise
`runner.cancel(jobId)` → `{ cancelled: true, priorState }`.

---

## 5. Job registry

We do not own a registry — we delegate to `@ageflow/server`'s
`RunRegistry`, instantiated via `createRunner(cfg)` in `server.ts`.

Defaults: `ttlMs = 30 min` (up from server's 5 min — MCP poll gap is larger);
`checkpointTtlMs = 1 hour` (matches server); `reaperIntervalMs = 60 s`.
Overridable via `McpServerOptions.jobTtlMs` / `jobCheckpointTtlMs`.

**Concurrency with the existing `BUSY` lock.** Today `server.ts` uses a
single boolean `inflight`. In async mode we keep it, but both paths share it:

```ts
// pseudo
if (inflight) return BUSY;
inflight = true;
try {
  if (name === syncToolName) {
    // existing sync path — blocks until run completes
  } else if (name === `start_${syncToolName}`) {
    // fire-and-forget: DO NOT set inflight=false in finally
    // instead, clear it from an onComplete / onError callback
    const handle = runner.fire(workflow, input, {
      onCheckpoint,
      onComplete: () => { inflight = false },
      onError:    () => { inflight = false },
    });
    return { jobId: handle.runId };
  } else {
    // observer tools (status/result/cancel): do NOT hold the lock.
    // Release immediately so polling doesn't block other pollers.
    inflight = false;
    return dispatchObserver(name, args);
  }
} finally {
  if (name === syncToolName) inflight = false;
}
```

Observer tools (`get_workflow_status`, `get_workflow_result`,
`cancel_workflow`) **do not acquire the inflight lock** — they're pure
reads against the registry and must be callable while a job is running.

**Event recorder.** `get_workflow_status.currentTask` / `.progress` need
more than `RunHandle` exposes, so we wire an `onEvent` into `fire()`
that feeds a `JobEventRecorder` — `Map<jobId, { lastTaskStart?,
tasksCompleted, lastBudgetWarning? }>`, trimmed lazily when the
corresponding `RunHandle` is gone from the registry.

### Future: `RunStore` hook

For a future "durable jobs" story, `RunRegistry` would grow an optional
`store?: RunStore` injection:

```ts
interface RunStore {
  save(handle: RunHandle): Promise<void>;
  load(runId: string): Promise<RunHandle | undefined>;
  delete(runId: string): Promise<void>;
}
```

Out of scope for this spec — noted so the API surface doesn't paint us
into a corner.

---

## 6. Async HITL

Today `hitl-bridge.ts` translates a checkpoint into an MCP **elicitation**
over the active connection. That only works when the caller is still
attached — true for the sync tool, false for async jobs (the `start_*`
caller may be gone).

**Rule:** HITL surfacing depends on which tool started the run.

| Starting tool         | Checkpoint surfacing                          | Resume path                          |
|-----------------------|-----------------------------------------------|--------------------------------------|
| Sync `<workflow>`     | MCP elicitation on the open connection (today)| Resolved inline; caller responds      |
| `start_<workflow>`    | Poll-based: `get_workflow_status` reports `state: "awaiting-checkpoint"` + `currentTask.message` | `resume_workflow` tool (below) |

### `resume_workflow` — implicit 5th job tool

```
input:  { jobId: string, approved: boolean }
output: { resumed: true }
```

`state !== "awaiting-checkpoint"` → `INVALID_RUN_STATE`. Otherwise
`runner.resume(jobId, approved)` clears the deferred checkpoint.

Issue #18 listed 4 tools; we expand to 5 because without
`resume_workflow` checkpoints would always hit `checkpointTtlMs` and
auto-reject.

`onCheckpoint` in the `Runner` is configured as **undefined** for job
mode, which triggers `@ageflow/server`'s built-in deferred path
(`handle.markAwaitingCheckpoint(ev, deferred.resolve)`). The `hitl-bridge`
is bypassed for job-mode runs; `hitlStrategy` still governs what happens
when no resume arrives before `checkpointTtlMs` (auto-rejected as today).

---

## 7. Error handling

New MCP error codes (added to `ErrorCode`):

```ts
JOB_NOT_FOUND:       "JOB_NOT_FOUND",         // unknown jobId
JOB_ALREADY_DONE:    "JOB_ALREADY_DONE",      // get_workflow_result on done → returns output (not error)
JOB_CANCELLED:       "JOB_CANCELLED",         // get_workflow_result on cancelled
INVALID_RUN_STATE:   "INVALID_RUN_STATE",     // resume on non-checkpoint state
ASYNC_MODE_DISABLED: "ASYNC_MODE_DISABLED",   // job tool called on non-async server (shouldn't happen; defensive)
```

Mapping of underlying errors from `@ageflow/server`:

| Thrown by server                     | MCP ErrorCode          |
|--------------------------------------|------------------------|
| `RunNotFoundError`                   | `JOB_NOT_FOUND`        |
| `InvalidRunStateError`               | `INVALID_RUN_STATE`    |
| `CheckpointTimeoutError` (from auto-reject) | `HITL_CANCELLED` (existing) |
| `BudgetExceededError` (from executor)| `BUDGET_EXCEEDED` (existing) |
| `HitlNotInteractiveError`            | `HITL_ELICITATION_UNSUPPORTED` (existing) |

All returned as `McpToolErrorResult` via the existing `formatErrorResult`.

**Explicit cases called out by issue #18:**

- **Job not found** → `JOB_NOT_FOUND`, HTTP-style "gone" signal. Idempotent:
  after `ttlMs` the handle is gone and this becomes the permanent response.
- **Already completed** (`get_workflow_result`) → **not an error** — returns
  the cached output. Calling `cancel_workflow` on a completed job returns
  `{ cancelled: false, priorState: "done" }` (also not an error).
- **Already cancelled** → `get_workflow_result` returns `JOB_CANCELLED`;
  `cancel_workflow` returns `{ cancelled: false, priorState: "cancelled" }`.

---

## 8. Testing strategy

New test file: `packages/mcp-server/src/__tests__/async-mode.test.ts`.

**Unit:**
- `buildJobTools(workflow)` produces exactly 5 `ToolDefinition`s with the
  expected names and schemas (snapshot test on JSON shape).
- `JobEventRecorder` correctly accumulates task-complete counts and
  surfaces the last `task:start` as `currentTask`.
- `listTools()` returns 1 tool when `async: false`, 6 when `async: true`
  (sync + 5 job tools).

**Integration (in-process, no transport):**
- **Happy path:** `start_x(input) → jobId`; poll `get_workflow_status`
  until `done`; `get_workflow_result` returns validated output; second
  call to `get_workflow_result` still returns cached output.
- **Cancellation:** `start_x → cancel_workflow → get_workflow_status`
  shows `cancelled`; `get_workflow_result` returns `JOB_CANCELLED`.
  Second `cancel_workflow` returns `{ cancelled: false, priorState:
  "cancelled" }`.
- **HITL via poll:** workflow emits `checkpoint`; `get_workflow_status`
  returns `state: "awaiting-checkpoint"` and
  `currentTask.kind === "checkpoint"`; `resume_workflow(jobId, true)`
  unblocks; run completes; `get_workflow_result` returns output.
- **HITL denied:** `resume_workflow(jobId, false)` → run ends with
  `state: "failed"`; `get_workflow_result` yields `HITL_DENIED`.
- **Checkpoint TTL:** freeze time (fake `Date.now`), wait past
  `checkpointTtlMs`; sweep runs; `state: "failed"` with
  `HITL_CANCELLED`-style error.
- **BUSY lock:** two concurrent `start_x` calls — second returns `BUSY`.
  After first completes, third `start_x` succeeds.
- **Validation:** bad input to `start_x` → `INPUT_VALIDATION_FAILED`;
  workflow that produces non-conforming output → `OUTPUT_VALIDATION_FAILED`
  on `get_workflow_result`.
- **Not-found paths:** every observer tool with unknown `jobId` →
  `JOB_NOT_FOUND`.

**Reused infra:** the `_testRunExecutor` injection hook on
`McpServerHandle` already lets tests replace the executor. We extend it
to accept a generator so tests can interleave checkpoint/complete events
deterministically (no real subprocess spawning).

**Type-level:** add a `.test-d.ts` asserting that `start_<workflow>`'s
input type is structurally identical to the sync tool's input type
(guards against schema drift between the two tool definitions).

---

## 9. Non-goals (recap)

Restated for emphasis, since issue #18 is deliberately narrow:

- **No distributed jobs.** Jobs are single-instance only.
- **No distributed persistence across server restart.** Restart recovery is
  supported only when a durable local `RunStore` backend is configured.
- **No job prioritization / queueing.** Single `BUSY` lock — same policy
  as sync mode.
- **No `list_jobs` / `wait_for_job` bulk APIs.** v2 if ever requested.
- **No auth model.** Transport-level trust only.
- **No new transport.** Still MCP over stdio (or whatever transport the
  embedder wires).

---

## Open questions

1. **Should `start_<workflow>` be named after the workflow (e.g.
   `start_my_workflow`) or use a generic `start_workflow` with a
   `workflowName` arg?** This spec chose the former for per-workflow
   input-schema typing; revisit if we ever expose multiple workflows per
   server.
2. **Is 30 min the right default for `jobTtlMs`?** Depends on target
   usage. Adjustable per-server.
3. **Should `get_workflow_result` consume the result** (delete on read,
   like SQS), or leave it cached until TTL? This spec chose **cached** —
   multiple clients may poll, idempotency is friendlier.

## Open follow-ups / future work

- **Additional durable backends.** Add Redis/Postgres-grade `RunStore`
  adapters where restart recovery must survive host replacement.
- **Webhook / push notifications.** Optional "call me at URL X when job
  finishes" so polling isn't required for clients that can accept
  callbacks.
- **Multi-workflow servers.** If one MCP server ever hosts more than one
  workflow, `cancel_workflow` / `get_workflow_status` become global but
  `start_*` stays per-workflow.
- **MCP spec alignment.** Watch upstream MCP for a standardized long-running
  tool pattern — if adopted, migrate to it and deprecate the bespoke tools.
