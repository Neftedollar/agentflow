# AgentFlow Server Execution — Design Spec

**Date:** 2026-04-16
**Status:** Draft
**Author:** Orchestrator (issue #26)

---

## Context

AgentFlow today runs workflows via the CLI (`agentwf run`) and MCP
(`@ageflow/mcp-server`). Neither fits an **application server** that needs
to stream progress to an HTTP client, pause on an HITL checkpoint across
requests, fire-and-forget background runs, or cancel on client disconnect.

This spec adds `@ageflow/server` — an embeddable execution surface any
Node/Bun server can host (Express, Fastify, Hono, Next.js, raw `http`).
AgentFlow does **not** ship an HTTP server; callers bring their framework
and wire the runner into routes.

The core primitive is a new `WorkflowExecutor.stream()` method that yields
structured events. `run()`, `fire()`, the CLI renderer, and future
transports are all re-expressed on top of it.

---

## Goals

- **Streaming is the primitive.** One `stream()` implementation; `run()`,
  `fire()`, the CLI, and any future transport consume events from it.
- **Zero breakage.** Existing `WorkflowExecutor.run(input?)` signature, return
  shape, and hook semantics are preserved. All current tests pass unchanged.
- **Async HITL.** A workflow can emit `checkpoint`, suspend indefinitely, and
  resume on `runner.resume(runId, approved)` from a different caller / request
  / process tick.
- **Composable with any HTTP framework.** `AsyncGenerator<WorkflowEvent>` is
  the contract. Turning events into SSE / WebSocket frames / JSONL / anything
  else is the caller's job (and trivial — examples in the roadmap).
- **Cancellable.** `AbortSignal` support end-to-end.
- **Run registry.** In-process map of `runId → RunHandle` with TTL cleanup so
  suspended runs don't leak.

## Non-goals

- **No bundled HTTP server.** We do not ship Express / Fastify middleware.
  Framework integrations live in userland or future packages.
- **No persistence.** Runs live in process memory. Restarting the server
  drops in-flight runs. Durable runs are a v0.2+ feature.
- **No distributed execution.** A `runId` is only valid on the instance that
  created it. Horizontal scale requires sticky sessions or external state,
  out of scope here.
- **No new transport format.** No JSONL-over-stdio, no WebSocket protocol
  defined here. Events are TypeScript values.
- **No changes to the runner interface.** `@ageflow/runners-claude` and
  `@ageflow/runners-codex` are unaffected.

---

## Architecture

### Package layout & dependencies

```
packages/server/src/
  index.ts            — public exports (createRunner, types)
  runner.ts           — Runner implementation
  run-registry.ts     — RunHandle map + TTL reaper
  run-handle.ts       — RunHandle internals (state, deferreds)
```

Dependencies: `@ageflow/core`, `@ageflow/executor`. **No** HTTP library
dependency. `cli` and `mcp-server` are unaffected.

### `WorkflowExecutor.stream()` — the new primitive

A second public method on the existing class in `@ageflow/executor`:

```ts
class WorkflowExecutor<T extends TasksMap> {
  // Existing — signature unchanged.
  async run(input?: unknown): Promise<WorkflowResult<T>>;

  // New.
  stream(
    input?: unknown,
    options?: StreamOptions,
  ): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void>;
}

interface StreamOptions {
  readonly signal?: AbortSignal;
  /** Called when a `checkpoint` event is emitted; must resolve to approve/deny. */
  readonly onCheckpoint?: (ev: CheckpointEvent) => Promise<boolean>;
}
```

Internal wiring:

- `stream()` is the real implementation. It iterates the DAG batches
  (same `topologicalSort` + `groupBySession` as today), but instead of
  calling hooks directly it pushes events onto an internal queue and
  `yield`s them.
- The existing **hooks keep firing** (`onTaskStart`, `onTaskComplete`,
  `onTaskError`, `onCheckpoint`, `onWorkflowComplete`) — they're called
  right before the equivalent event is yielded. This is how we get
  "zero breakage": CLI and tests that rely on hooks see identical
  behavior.
- `run()` is reimplemented as a thin drain over `stream()`:

  ```ts
  async run(input?: unknown): Promise<WorkflowResult<T>> {
    const gen = this.stream(input, { onCheckpoint: legacyHitlAdapter });
    let result: IteratorResult<WorkflowEvent, WorkflowResult<T>>;
    do { result = await gen.next(); } while (!result.done);
    return result.value;
  }
  ```

  The `legacyHitlAdapter` defers to the existing `HITLManager` (hook or
  TTY prompt), preserving current CLI behavior 1:1.

### Async HITL flow

The existing `HITLManager.runCheckpoint()` blocks on either a hook or a TTY
prompt. For `stream()` we add a **third** path: suspend via a deferred
promise that is resolved externally by `runner.resume(runId, approved)`.

Flow during `stream()`:

1. Executor reaches a task with `hitl: { mode: "checkpoint" }`.
2. Executor fires `hooks.onCheckpoint(taskName, message)` (unchanged).
3. Executor yields a `CheckpointEvent` and **awaits** a deferred
   `Promise<boolean>` stored on the `RunHandle`.
4. The stream pauses — no more events are produced until the promise
   resolves.
5. Caller (HTTP handler, test, whatever) eventually calls
   `runner.resume(runId, true | false)`.
6. That call resolves the deferred.
7. If `approved === true`, the executor continues to the next batch.
   If `false`, it throws `HitlRejectedError` (new), which is caught and
   emitted as a terminal `workflow:error` event.

Inside a plain `executor.run()` call with no `onCheckpoint` option, the
checkpoint falls back to the existing hook-or-TTY path (`HITLManager`
behavior unchanged). So CLI keeps prompting on TTY exactly like today.

### Run registry

`@ageflow/server` owns a `RunRegistry` — an in-memory `Map<string, RunHandle>`.

```ts
interface RunHandle {
  readonly runId: string;
  readonly workflow: WorkflowDef;
  readonly createdAt: number;
  readonly state: RunState;
  readonly lastEventAt: number;
  readonly abort: AbortController;
  /** Set when state === "awaiting-checkpoint". */
  readonly pendingCheckpoint?: {
    readonly event: CheckpointEvent;
    readonly resolve: (approved: boolean) => void;
  };
  /** Terminal state only. */
  readonly result?: WorkflowResult<TasksMap>;
  readonly error?: Error;
}

type RunState =
  | "running"
  | "awaiting-checkpoint"
  | "done"
  | "failed"
  | "cancelled";
```

State transitions:

```
running ──┬─→ awaiting-checkpoint ──(resume true)──→ running
          ├─→ done        (terminal)
          ├─→ failed      (terminal, also from resume false / timeout)
          └─→ cancelled   (terminal, from cancel() / AbortSignal)
```

Cleanup:

- A reaper (`setInterval`, unref'd) runs every 60 s and removes handles
  whose `state ∈ {done, failed, cancelled}` and `lastEventAt` is older
  than `ttlMs` (default: 5 min).
- `awaiting-checkpoint` runs have a separate `checkpointTtlMs`
  (default: 1 hour). When exceeded the run is auto-rejected and moves
  to `failed` with `CheckpointTimeoutError`.
- Both TTLs are configurable on `createRunner()`.

---

## DSL / Type Changes in `@ageflow/core`

### `WorkflowEvent` union (new)

```ts
export type WorkflowEvent =
  | WorkflowStartEvent
  | TaskStartEvent
  | TaskCompleteEvent
  | TaskErrorEvent
  | TaskRetryEvent
  | CheckpointEvent
  | BudgetWarningEvent
  | WorkflowCompleteEvent
  | WorkflowErrorEvent;

interface EventBase {
  readonly runId: string;
  readonly workflowName: string;
  readonly timestamp: number; // Date.now()
}

export interface WorkflowStartEvent extends EventBase {
  readonly type: "workflow:start";
  readonly input: unknown;
}

export interface TaskStartEvent extends EventBase {
  readonly type: "task:start";
  readonly taskName: string;
}

export interface TaskCompleteEvent extends EventBase {
  readonly type: "task:complete";
  readonly taskName: string;
  readonly output: unknown;
  readonly metrics: TaskMetrics;
}

export interface TaskErrorEvent extends EventBase {
  readonly type: "task:error";
  readonly taskName: string;
  readonly error: { name: string; message: string; stack?: string };
  readonly attempt: number;
  readonly terminal: boolean; // true if retries exhausted
}

export interface TaskRetryEvent extends EventBase {
  readonly type: "task:retry";
  readonly taskName: string;
  readonly attempt: number; // the attempt about to start
  readonly reason: string;
}

export interface CheckpointEvent extends EventBase {
  readonly type: "checkpoint";
  readonly taskName: string;
  readonly message: string;
}

export interface BudgetWarningEvent extends EventBase {
  readonly type: "budget:warning";
  readonly spentUsd: number;
  readonly limitUsd: number;
}

export interface WorkflowCompleteEvent extends EventBase {
  readonly type: "workflow:complete";
  readonly result: { outputs: Record<string, unknown>; metrics: WorkflowMetrics };
}

export interface WorkflowErrorEvent extends EventBase {
  readonly type: "workflow:error";
  readonly error: { name: string; message: string; stack?: string };
}
```

`CheckpointEvent` deliberately serializes cleanly to JSON (no callbacks,
no class instances) — callers can forward it to an HTTP client verbatim.

### `RunHandle` (exposed read-only)

```ts
export interface RunHandle {
  readonly runId: string;
  readonly state: RunState;
  readonly workflowName: string;
  readonly createdAt: number;
  readonly lastEventAt: number;
  /** Present only when state === "awaiting-checkpoint". */
  readonly pendingCheckpoint?: CheckpointEvent;
  /** Present only when state === "done". */
  readonly result?: { outputs: Record<string, unknown>; metrics: WorkflowMetrics };
  /** Present only when state === "failed". */
  readonly error?: { name: string; message: string };
}
```

### `Runner` interface

```ts
export interface Runner {
  /** Stream events for a run. Yields events, returns final result. */
  stream<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: RunOptions,
  ): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void>;

  /** Drain stream(); return final result. Never emits `checkpoint` to the caller. */
  run<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: RunOptions,
  ): Promise<WorkflowResult<T>>;

  /** Start in background; invoke callbacks; return RunHandle immediately. */
  fire<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: FireOptions,
  ): RunHandle;

  /** Unblock a checkpoint. Throws if run is not in `awaiting-checkpoint`. */
  resume(runId: string, approved: boolean): void;

  /** Abort a run via its AbortSignal. Idempotent. */
  cancel(runId: string): void;

  /** Current snapshot for a run, or undefined if unknown/evicted. */
  get(runId: string): RunHandle | undefined;

  /** All live handles (running, awaiting-checkpoint, and un-evicted terminal). */
  list(): readonly RunHandle[];
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  /** If omitted, stream() will emit checkpoint events; run() will auto-reject. */
  readonly onCheckpoint?: (ev: CheckpointEvent) => Promise<boolean> | boolean;
}

export interface FireOptions extends RunOptions {
  readonly onEvent?: (ev: WorkflowEvent) => void;
  readonly onError?: (err: Error) => void;
  readonly onComplete?: (result: WorkflowResult<TasksMap>) => void;
}
```

---

## API Surface — `@ageflow/server`

### Exports

```ts
// packages/server/src/index.ts
export { createRunner } from "./runner";
export type {
  Runner,
  RunHandle,
  RunState,
  RunOptions,
  FireOptions,
  RunnerConfig,
} from "./types";
// Event types come from @ageflow/core and are re-exported for convenience.
export type { WorkflowEvent, CheckpointEvent, /* … */ } from "@ageflow/core";
```

### `createRunner(config?)`

```ts
export interface RunnerConfig {
  /** Terminal-run TTL before GC. Default: 5 min. */
  readonly ttlMs?: number;
  /** Awaiting-checkpoint TTL before auto-reject. Default: 1 hour. */
  readonly checkpointTtlMs?: number;
  /** How often the reaper sweeps. Default: 60 s. */
  readonly reaperIntervalMs?: number;
  /** runId generator. Default: `crypto.randomUUID()`. */
  readonly generateRunId?: () => string;
}

export function createRunner(config?: RunnerConfig): Runner;
```

### Usage

```ts
const runner = createRunner();

// Stream — primary path. Caller chooses the transport.
for await (const ev of runner.stream(myWorkflow, input)) {
  send(`data: ${JSON.stringify(ev)}\n\n`);
  if (ev.type === "checkpoint") break;  // 202 the client, resume later
}

// Await a full result.
const { outputs, metrics } = await runner.run(myWorkflow, input);

// Fire-and-forget; returns RunHandle synchronously.
const handle = runner.fire(myWorkflow, input, {
  onEvent: logger.info,
  onComplete: ({ outputs }) => db.save(outputs),
  onError: logger.error,
});

// Resume a paused run from a different request.
runner.resume(runId, /* approved */ true);

// Cancel.
runner.cancel(runId);
// or via AbortSignal at start:
runner.stream(wf, input, { signal: ac.signal });
```

---

## Run Registry — details

### Lifecycle

| State                   | Entered when                         | Exited when                                       |
|-------------------------|--------------------------------------|---------------------------------------------------|
| `running`               | `stream`/`run`/`fire` starts         | checkpoint hit, done, failed, cancel              |
| `awaiting-checkpoint`   | `CheckpointEvent` yielded            | `resume()` called, checkpoint TTL, cancel         |
| `done`                  | final batch succeeds                 | TTL expires → evicted from map                    |
| `failed`                | terminal error (or `resume(false)`)  | TTL expires → evicted from map                    |
| `cancelled`             | `cancel()` or `AbortSignal` aborted  | TTL expires → evicted from map                    |

### Reaper

- Runs on `setInterval(reaperIntervalMs).unref()` — doesn't keep the
  process alive.
- For each handle:
  - Terminal (`done | failed | cancelled`) and `now - lastEventAt > ttlMs`
    → delete.
  - `awaiting-checkpoint` and `now - lastEventAt > checkpointTtlMs` →
    auto-reject (`resolve(false)` internally), which pushes the run to
    `failed` with `CheckpointTimeoutError`. Next sweep evicts it.

### `lastEventAt`

Updated on every yielded event and every state transition. Gives us a
stable "last activity" clock for both TTLs without tracking events
individually.

---

## Error Handling

| Error class (new or existing)   | When                                                   | Event emitted                  |
|---------------------------------|--------------------------------------------------------|--------------------------------|
| any `Error` from a task         | task throws after retries exhausted                    | `task:error` (terminal: true)  |
| `BudgetExceededError` (exists)  | budget.onExceed === "halt" and cap hit                 | `workflow:error`               |
| `HitlRejectedError` (new)       | `resume(runId, false)`                                 | `workflow:error`               |
| `CheckpointTimeoutError` (new)  | checkpoint TTL elapsed                                 | `workflow:error`               |
| `AbortError` (standard)         | `AbortSignal` aborted or `cancel()` called             | no event; generator just ends  |
| `RunNotFoundError` (new)        | `resume`/`cancel` with unknown runId                   | thrown synchronously           |
| `InvalidRunStateError` (new)    | `resume` when not in `awaiting-checkpoint`             | thrown synchronously           |

All errors emitted as events are JSON-safe: `{ name, message, stack? }`.

---

## Testing Strategy

1. **Unit — `stream()` event sequence.** Mock runner, mock workflow;
   assert exact event order for happy path, task failure, retry,
   budget-warning, checkpoint-approved, checkpoint-rejected.
2. **Unit — `run()` regression.** All existing `WorkflowExecutor` tests
   must pass. Add a new parameterized pair: same workflow run via
   `run()` and via draining `stream()` → identical `WorkflowResult`.
3. **Unit — registry state machine.** Drive transitions manually, assert
   reaper evicts correctly at each state with fake timers.
4. **Unit — async HITL.** Start `stream()`, observe `checkpoint` event,
   call `resume(true)` / `resume(false)`, assert continuation or
   `workflow:error` with `HitlRejectedError`. Repeat with checkpoint TTL
   expiring via fake timers.
5. **Unit — cancel.** `AbortController.abort()` mid-run; assert no
   further events after abort and handle state = `cancelled`.
6. **Integration — real workflow.** Reuse dogfooding workflow; drive via
   `createRunner().stream()`; assert events match hook fires 1:1.
7. **Integration — HTTP shim.** A tiny example in `examples/server/`
   wires Hono + SSE using `runner.stream()`. Not shipped as a package;
   it's a reference for users.
8. **Type-level.** `expectTypeOf` assertions that `stream()` yields
   `WorkflowEvent` and returns `WorkflowResult<T>` with output types
   inferred from `T`.

---

## Roadmap (v0.2 teasers)

- **Durable runs.** Pluggable `RunStore`; SQLite + Redis reference
  impls. Replay events on restart from a persisted log.
- **`@ageflow/server-http`.** Opinionated middleware for
  Express/Hono/Fastify: `/runs`, `/runs/:id/stream` (SSE),
  `/runs/:id/resume`.
- **Distributed runs.** Pub/sub resume channel so any instance can
  resume a checkpoint started on another.
- **Event filtering.** `stream(wf, input, { filter: [...] })`.
- **`subscribe(runId)`.** Second observer joining an in-flight run.

---

## Decisions resolved

- `run()` without `onCheckpoint` **auto-rejects** checkpoints (least
  privilege). CLI keeps its TTY behavior via an explicit `onCheckpoint`
  adapter that defers to `HITLManager`.
- `task:retry` events require threading a callback through
  `node-runner.ts` — additive, in scope.
- `stream()` always starts a new run; observing an in-flight run is a
  v0.2 concern (`subscribe`).
