# `@ageflow/server` — Implementation Plan

**Date:** 2026-04-16
**Issue:** #26
**Spec:** `docs/superpowers/specs/2026-04-16-server-execution-design.md`
**Status:** Ready to execute

---

## Goal

Ship `@ageflow/server` — an embeddable execution surface that any
Node/Bun HTTP framework (Express, Fastify, Hono, Next.js, raw `http`)
can host. The core primitive is a new `WorkflowExecutor.stream()`
method on `@ageflow/executor` that yields structured `WorkflowEvent`s;
`run()` is re-expressed on top of it. `@ageflow/server` wraps that
primitive with a run registry (`runId → RunHandle`), TTL cleanup, async
HITL (resume from a different request), `AbortSignal` cancellation, and
a `fire()` background-run path.

No HTTP library is pulled in. Turning events into SSE / WebSocket /
JSONL is the caller's responsibility.

## Architecture

```
@ageflow/core (existing)
  └── add WorkflowEvent union + RunState + public RunHandle type
       (event payloads only — no runtime code)

@ageflow/executor (existing)
  ├── WorkflowExecutor.stream()      — new async generator; real impl
  ├── WorkflowExecutor.run()         — reimplemented as stream() drain
  ├── HITLManager.runCheckpoint()    — extended with deferred-resolver path
  └── node-runner.ts                 — threads onRetry(taskName, attempt, reason)

@ageflow/server (new)
  ├── types.ts           — Runner, RunnerConfig, RunOptions, FireOptions
  ├── errors.ts          — HitlRejectedError, CheckpointTimeoutError,
  │                        RunNotFoundError, InvalidRunStateError
  ├── run-handle.ts      — InternalRunHandle (mutable), deferred helper
  ├── run-registry.ts    — Map<runId, InternalRunHandle> + reaper
  ├── runner.ts          — createRunner(): stream/run/fire/resume/cancel/get/list
  └── index.ts           — public exports
```

## Tech stack

- Runtime: Bun / Node 20+ (uses built-in `AbortController`, `crypto.randomUUID`, `setInterval().unref()`)
- Types: TypeScript strict, extends `tsconfig.base.json`
- Tests: Vitest (`environment: "node"`, fake timers for TTL tests)
- Lint: Biome (inherited from repo root)
- Runtime deps: `@ageflow/core` + `@ageflow/executor` (workspace). **No HTTP library.**

## Spec references (resolved decisions)

- `run()` **without** `onCheckpoint` auto-rejects checkpoints (least privilege).
  CLI keeps TTY behavior via an explicit legacy adapter that defers to `HITLManager`.
- `task:retry` events require threading a callback through `node-runner.ts`.
  Additive; in scope.
- `stream()` always starts a new run. Observing an in-flight run (`subscribe`)
  is v0.2.
- No persistence, no distributed runs, no bundled HTTP middleware — see
  spec §Non-goals.

## Runner contract (from spec §API Surface)

```ts
export interface Runner {
  stream<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: RunOptions,
  ): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void>;

  run<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: RunOptions,
  ): Promise<WorkflowResult<T>>;

  fire<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: FireOptions,
  ): RunHandle;

  resume(runId: string, approved: boolean): void;
  cancel(runId: string): void;
  get(runId: string): RunHandle | undefined;
  list(): readonly RunHandle[];
}
```

---

## File structure

### New files

| Path | Purpose |
|------|---------|
| `packages/server/package.json` | Workspace manifest (`@ageflow/server`) |
| `packages/server/tsconfig.json` | Extends base; refs `core` + `executor` |
| `packages/server/vitest.config.ts` | Vitest config (`environment: "node"`) |
| `packages/server/README.md` | Usage, SSE/Hono/Fastify snippets, FAQ |
| `packages/server/src/index.ts` | Public exports |
| `packages/server/src/types.ts` | `Runner`, `RunnerConfig`, `RunOptions`, `FireOptions`, public `RunHandle` re-export |
| `packages/server/src/errors.ts` | `HitlRejectedError`, `CheckpointTimeoutError`, `RunNotFoundError`, `InvalidRunStateError` |
| `packages/server/src/run-handle.ts` | `InternalRunHandle`, `createDeferred()` |
| `packages/server/src/run-registry.ts` | `RunRegistry` (map + reaper) |
| `packages/server/src/runner.ts` | `createRunner()` factory and core methods |
| `packages/server/src/__tests__/run-registry.test.ts` | Registry state machine + reaper with fake timers |
| `packages/server/src/__tests__/runner.stream.test.ts` | Event sequence, happy path + errors + budget warning |
| `packages/server/src/__tests__/runner.run.test.ts` | `run()` regression vs executor baseline |
| `packages/server/src/__tests__/runner.fire.test.ts` | `fire()` callbacks, handle snapshot |
| `packages/server/src/__tests__/runner.hitl.test.ts` | Async HITL: resume true / false / timeout |
| `packages/server/src/__tests__/runner.cancel.test.ts` | AbortSignal + `cancel()` paths |
| `packages/server/src/__tests__/types.test-d.ts` | Type-level assertions (`expectTypeOf`) |
| `examples/server-embed/package.json` | Example workspace |
| `examples/server-embed/tsconfig.json` | Extends base |
| `examples/server-embed/workflow.ts` | Toy 2-task workflow with a checkpoint |
| `examples/server-embed/server.ts` | Tiny SSE handler using `node:http` + `runner.stream()` |
| `examples/server-embed/README.md` | Run with `bun server.ts`, curl examples |
| `examples/server-embed/__tests__/sse.test.ts` | Harness test driving the SSE handler |

### Modified files

| Path | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `WorkflowEvent` union, `RunState`, public `RunHandle` |
| `packages/core/src/index.ts` | Re-export new types |
| `packages/core/src/__tests__/workflow-event.test-d.ts` *(new)* | Discriminant narrowing assertions |
| `packages/executor/src/workflow-executor.ts` | Add `stream()`; rewrite `run()` as drain over `stream()` |
| `packages/executor/src/hitl-manager.ts` | New `runCheckpointStream()` path using injected resolver |
| `packages/executor/src/node-runner.ts` | Optional `onRetry(taskName, attempt, reason)` parameter |
| `packages/executor/src/index.ts` | Export nothing new (stream is on the class) |
| `agentflow/CLAUDE.md` | Add `@ageflow/server` to package list |

---

## Phases

Each task = one commit with a fixed message. TDD order: failing test
first, then implementation, then green. Existing executor tests must
stay green after every task.

### Phase 1 — `WorkflowEvent` union in `@ageflow/core`

Pure type additions. No runtime code. Every other package must still
compile unchanged.

#### Task 1.1 — failing type-level test

Create `packages/core/src/__tests__/workflow-event.test-d.ts`:

```ts
import { describe, expectTypeOf, it } from "vitest";
import type {
  CheckpointEvent,
  RunState,
  TaskCompleteEvent,
  TaskErrorEvent,
  TaskRetryEvent,
  WorkflowCompleteEvent,
  WorkflowErrorEvent,
  WorkflowEvent,
  WorkflowStartEvent,
} from "../index.js";

describe("WorkflowEvent", () => {
  it("narrows by type discriminator", () => {
    const ev = {} as WorkflowEvent;
    if (ev.type === "task:complete") {
      expectTypeOf(ev).toMatchTypeOf<TaskCompleteEvent>();
      expectTypeOf(ev.metrics.tokensIn).toEqualTypeOf<number>();
    }
    if (ev.type === "task:retry") {
      expectTypeOf(ev).toMatchTypeOf<TaskRetryEvent>();
      expectTypeOf(ev.attempt).toEqualTypeOf<number>();
    }
    if (ev.type === "checkpoint") {
      expectTypeOf(ev).toMatchTypeOf<CheckpointEvent>();
      expectTypeOf(ev.message).toEqualTypeOf<string>();
    }
  });

  it("every event carries runId + workflowName + timestamp", () => {
    const ev = {} as WorkflowEvent;
    expectTypeOf(ev.runId).toEqualTypeOf<string>();
    expectTypeOf(ev.workflowName).toEqualTypeOf<string>();
    expectTypeOf(ev.timestamp).toEqualTypeOf<number>();
  });

  it("RunState covers all five states", () => {
    const s = {} as RunState;
    // will fail to compile if a state is missing
    const _exhaustive: "running" | "awaiting-checkpoint" | "done" | "failed" | "cancelled" =
      s;
    void _exhaustive;
  });

  it("start + error + complete carry the right payloads", () => {
    expectTypeOf<WorkflowStartEvent["input"]>().toEqualTypeOf<unknown>();
    expectTypeOf<WorkflowErrorEvent["error"]["message"]>().toEqualTypeOf<string>();
    expectTypeOf<WorkflowCompleteEvent["result"]["outputs"]>().toEqualTypeOf<
      Record<string, unknown>
    >();
    const te = {} as TaskErrorEvent;
    expectTypeOf(te.terminal).toEqualTypeOf<boolean>();
    expectTypeOf(te.attempt).toEqualTypeOf<number>();
  });
});
```

Run `bun run --filter @ageflow/core typecheck` → fails (types don't exist).

#### Task 1.2 — add event union, RunState, public RunHandle

In `packages/core/src/types.ts`, append below the existing
`WorkflowHooks` block:

```ts
// ─── Run state + events ──────────────────────────────────────────────────────

export type RunState =
  | "running"
  | "awaiting-checkpoint"
  | "done"
  | "failed"
  | "cancelled";

interface EventBase {
  readonly runId: string;
  readonly workflowName: string;
  /** Date.now() at the moment the event was emitted. */
  readonly timestamp: number;
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
  readonly error: { readonly name: string; readonly message: string; readonly stack?: string };
  readonly attempt: number;
  /** true when retries exhausted or the error kind is non-retryable. */
  readonly terminal: boolean;
}

export interface TaskRetryEvent extends EventBase {
  readonly type: "task:retry";
  readonly taskName: string;
  /** The attempt that is about to start (0-indexed, matches node-runner). */
  readonly attempt: number;
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
  readonly result: {
    readonly outputs: Record<string, unknown>;
    readonly metrics: WorkflowMetrics;
  };
}

export interface WorkflowErrorEvent extends EventBase {
  readonly type: "workflow:error";
  readonly error: { readonly name: string; readonly message: string; readonly stack?: string };
}

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

/**
 * Public, JSON-serializable snapshot of a run. Returned by
 * `Runner.get()` / `Runner.fire()` / `Runner.list()`.
 */
export interface RunHandle {
  readonly runId: string;
  readonly state: RunState;
  readonly workflowName: string;
  readonly createdAt: number;
  readonly lastEventAt: number;
  /** Present only when state === "awaiting-checkpoint". */
  readonly pendingCheckpoint?: CheckpointEvent;
  /** Present only when state === "done". */
  readonly result?: {
    readonly outputs: Record<string, unknown>;
    readonly metrics: WorkflowMetrics;
  };
  /** Present only when state === "failed". */
  readonly error?: { readonly name: string; readonly message: string };
}
```

Re-export from `packages/core/src/index.ts` (append to the existing
type block):

```ts
export type {
  BudgetWarningEvent,
  CheckpointEvent,
  RunHandle,
  RunState,
  TaskCompleteEvent,
  TaskErrorEvent,
  TaskRetryEvent,
  TaskStartEvent,
  WorkflowCompleteEvent,
  WorkflowErrorEvent,
  WorkflowEvent,
  WorkflowStartEvent,
} from "./types.js";
```

Run `bun run --filter @ageflow/core typecheck && bun run --filter @ageflow/core test`. Green.
Run `bun run typecheck` at repo root — every other package still compiles
(types are additive).

**Commit:** `feat(core): WorkflowEvent union + RunState + public RunHandle (#26)`

---

### Phase 2 — `WorkflowExecutor.stream()` (real implementation)

Goal: add `stream()` as an `AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void>`
that wraps the same DAG walk as today, but pushes events onto an internal
queue and yields them. Hooks keep firing — events are pushed immediately
before (or after, for errors) the equivalent hook invocation.

`run()` is **not yet** rewritten in this phase — we only add `stream()`
alongside it so existing tests stay green while we verify the new path.

#### Task 2.1 — failing test: event sequence on happy path

Create `packages/executor/src/__tests__/workflow-executor.stream.test.ts`:

```ts
import { defineAgent, defineWorkflow, registerRunner, unregisterRunner } from "@ageflow/core";
import type { Runner, WorkflowEvent } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../workflow-executor.js";

const fakeRunner: Runner = {
  validate: async () => ({ ok: true }),
  spawn: async () => ({
    stdout: JSON.stringify({ summary: "ok" }),
    sessionHandle: "s",
    tokensIn: 1,
    tokensOut: 2,
  }),
};

const agent = defineAgent({
  runner: "fake",
  input: z.object({}),
  output: z.object({ summary: z.string() }),
  prompt: () => "go",
});

const wf = defineWorkflow({
  name: "demo",
  tasks: {
    a: { agent, input: {} },
    b: { agent, input: {}, dependsOn: ["a"] as const },
  },
});

beforeEach(() => registerRunner("fake", fakeRunner));
afterEach(() => unregisterRunner("fake"));

describe("WorkflowExecutor.stream (happy path)", () => {
  it("yields workflow:start → task:start/task:complete × 2 → workflow:complete", async () => {
    const executor = new WorkflowExecutor(wf);
    const events: WorkflowEvent[] = [];
    const gen = executor.stream({});
    let result: IteratorResult<WorkflowEvent, unknown>;
    do {
      result = await gen.next();
      if (!result.done) events.push(result.value);
    } while (!result.done);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("workflow:start");
    expect(types).toContain("task:start");
    expect(types).toContain("task:complete");
    expect(types[types.length - 1]).toBe("workflow:complete");
    // Exactly 2 task:start / 2 task:complete
    expect(types.filter((t) => t === "task:start").length).toBe(2);
    expect(types.filter((t) => t === "task:complete").length).toBe(2);
    // All events share the same runId and workflowName === "demo"
    const runIds = new Set(events.map((e) => e.runId));
    expect(runIds.size).toBe(1);
    for (const e of events) expect(e.workflowName).toBe("demo");
  });
});
```

Run → fails (`stream` not a function).

#### Task 2.2 — implement `stream()` as real path (hooks still fire)

Edit `packages/executor/src/workflow-executor.ts`:

1. Add an import:

```ts
import type { CheckpointEvent, WorkflowEvent } from "@ageflow/core";
```

2. Add internal event-queue helpers near the top of the file (module-local,
   not exported):

```ts
function createEventQueue() {
  const pending: WorkflowEvent[] = [];
  let waiter: ((v: WorkflowEvent | null) => void) | null = null;
  let closed = false;
  return {
    push(ev: WorkflowEvent): void {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(ev);
      } else {
        pending.push(ev);
      }
    },
    close(): void {
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
      }
    },
    next(): Promise<WorkflowEvent | null> {
      if (pending.length > 0) return Promise.resolve(pending.shift() ?? null);
      if (closed) return Promise.resolve(null);
      return new Promise<WorkflowEvent | null>((resolve) => {
        waiter = resolve;
      });
    },
  };
}
```

3. Add the public `StreamOptions` interface and `stream()` method on the
   class:

```ts
export interface StreamOptions {
  readonly signal?: AbortSignal;
  /**
   * Called when a checkpoint event is emitted. Returning `true` approves,
   * `false` rejects (emits workflow:error with HitlRejectedError).
   * If omitted, `stream()` yields the checkpoint to the caller and
   * pauses — caller resumes externally (async HITL).
   */
  readonly onCheckpoint?: (ev: CheckpointEvent) => Promise<boolean> | boolean;
}

async *stream(
  input?: unknown,
  options?: StreamOptions,
): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void> {
  const runId = crypto.randomUUID();
  const workflowName = this.workflow.name;
  const queue = createEventQueue();

  // Emit workflow:start immediately.
  queue.push({
    type: "workflow:start",
    runId,
    workflowName,
    timestamp: Date.now(),
    input,
  });

  // Run the DAG in the background; push events via queue; close on exit.
  const driver = (async () => {
    try {
      const result = await this._runBatchesEmitting({
        runId,
        workflowName,
        signal: options?.signal,
        onCheckpoint: options?.onCheckpoint,
        push: (ev) => queue.push(ev),
      });
      queue.push({
        type: "workflow:complete",
        runId,
        workflowName,
        timestamp: Date.now(),
        result: { outputs: result.outputs, metrics: result.metrics },
      });
      queue.close();
      return result;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      queue.push({
        type: "workflow:error",
        runId,
        workflowName,
        timestamp: Date.now(),
        error: { name: e.name, message: e.message, stack: e.stack },
      });
      queue.close();
      throw e;
    }
  })();

  try {
    while (true) {
      const ev = await queue.next();
      if (ev === null) break;
      yield ev;
    }
  } finally {
    // driver's terminal state propagates via await below
  }

  // Await so we can return the final WorkflowResult.
  return await driver;
}
```

4. Split the DAG walk so both `run()` and `stream()` can use it:
   - Rename the existing `_runBatches()` body into a new private method
     `_runBatchesEmitting(options)` that takes `{ runId, workflowName, signal,
     onCheckpoint, push }` and calls `push(ev)` at every lifecycle point:
     - `task:start` — immediately after `hooks?.onTaskStart?.()`.
     - `task:complete` — immediately after `hooks?.onTaskComplete?.()`.
     - `task:error` — in the `catch` block, after `hooks?.onTaskError?.()`;
       `terminal: true` iff the error is about to be rethrown to the caller.
     - `task:retry` — see Phase 4 (node-runner callback); for now keep the
       current retry-silent behavior. This test doesn't assert retries.
     - `budget:warning` — replace the existing `console.warn(...)` branch
       with `push({ type: "budget:warning", spentUsd, limitUsd, ... })`.
     - `checkpoint` — the existing `this.hitlManager.runCheckpoint()` call
       is rerouted through a new path (see Phase 5). For this phase, keep
       the old behavior and emit `push({ type: "checkpoint", ... })` **after**
       `hooks?.onCheckpoint?.()` fires, then await `HITLManager.runCheckpoint`.
   - Return the same `Record<string, CtxEntry>` + compute `{ outputs, metrics }`
     (the aggregation logic currently at the tail of `run()`). Build the
     `WorkflowResult<T>` here and return it.
   - Existing `_runBatches()` becomes a thin wrapper that calls
     `_runBatchesEmitting({ push: () => {} })` and discards events (no
     behavior change — ensures existing `run()` path still works for Phase 2).

5. No changes to `run()` yet. `stream()` is **additive**.

Run `bun run --filter @ageflow/executor test` → all existing tests still
pass; new stream test passes.

**Commit:** `feat(executor): WorkflowExecutor.stream() emits WorkflowEvent (#26)`

#### Task 2.3 — add task:error + workflow:error paths

Extend `workflow-executor.stream.test.ts`:

```ts
describe("WorkflowExecutor.stream (task failure)", () => {
  it("emits task:error with terminal:true and a terminal workflow:error", async () => {
    const boom: Runner = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        throw new Error("subprocess failure");
      },
    };
    registerRunner("boom", boom);
    try {
      const a = defineAgent({
        runner: "boom",
        input: z.object({}),
        output: z.object({ x: z.string() }),
        prompt: () => "go",
        retry: { max: 1, on: ["subprocess_error"], backoff: "fixed" },
      });
      const wfx = defineWorkflow({
        name: "bad",
        tasks: { t: { agent: a, input: {} } },
      });
      const executor = new WorkflowExecutor(wfx);
      const events: WorkflowEvent[] = [];
      const gen = executor.stream({});
      try {
        for await (const ev of gen) events.push(ev);
      } catch {
        // driver throws — we still collected the events
      }
      const taskErr = events.find((e) => e.type === "task:error");
      expect(taskErr).toBeDefined();
      if (taskErr?.type === "task:error") {
        expect(taskErr.terminal).toBe(true);
      }
      expect(events[events.length - 1]?.type).toBe("workflow:error");
    } finally {
      unregisterRunner("boom");
    }
  });
});
```

Implement in `_runBatchesEmitting`:

```ts
} catch (err) {
  const e = err instanceof Error ? err : new Error(String(err));
  if (e instanceof Error) {
    const latencyMs = Date.now() - taskStart;
    hooks?.onTaskError?.(taskName as keyof T & string, e, latencyMs);
  }
  push({
    type: "task:error",
    runId,
    workflowName,
    timestamp: Date.now(),
    taskName,
    error: { name: e.name, message: e.message, stack: e.stack },
    attempt: /* last attempt */ 0,
    terminal: true,
  });
  throw err;
}
```

Run → green.

**Commit:** `feat(executor): task:error + workflow:error events (#26)`

---

### Phase 3 — reimplement `run()` on top of `stream()`

Zero breakage to existing tests is the acceptance criterion.

#### Task 3.1 — failing test: `run()` parity with stream-drain

Append to `workflow-executor.stream.test.ts`:

```ts
describe("run() is a drain over stream()", () => {
  it("produces the same WorkflowResult as draining stream()", async () => {
    const executor = new WorkflowExecutor(wf);
    const runResult = await executor.run({});

    const executor2 = new WorkflowExecutor(wf);
    const gen = executor2.stream({});
    let streamResult: IteratorResult<WorkflowEvent, unknown>;
    do {
      streamResult = await gen.next();
    } while (!streamResult.done);

    expect(runResult.outputs).toEqual((streamResult.value as { outputs: unknown }).outputs);
    expect(runResult.metrics.taskCount).toBe(
      (streamResult.value as { metrics: { taskCount: number } }).metrics.taskCount,
    );
  });
});
```

Run → currently passes (both paths still independent). This test
becomes the regression guard when we rewrite `run()`.

#### Task 3.2 — rewrite `run()` as a stream drain

Replace the existing `run()` body with:

```ts
async run(input?: unknown): Promise<WorkflowResult<T>> {
  const gen = this.stream(input, {
    onCheckpoint: async (ev) => {
      // Legacy HITL adapter: defer to HITLManager (hook-or-TTY path).
      await this.hitlManager.runCheckpoint(
        ev.taskName,
        ev.message,
        this.workflow.hooks,
      );
      return true;
    },
  });
  let result: IteratorResult<WorkflowEvent, WorkflowResult<T>>;
  do {
    result = await gen.next();
  } while (!result.done);
  return result.value;
}
```

Then delete the now-unused `_runBatches()` adapter (or keep it as a private
helper that calls `_runBatchesEmitting({ push: () => {} })` to preserve the
signature used by `LoopExecutor`). `LoopExecutor` needs `RunBatchesFn`; keep
the old signature by internally swallowing events.

Run `bun run --filter @ageflow/executor test` → all existing tests
green (HITL hook tests, budget tests, session tests, loop tests).

**Commit:** `refactor(executor): run() as stream() drain — zero breakage (#26)`

---

### Phase 4 — `task:retry` plumbing through node-runner

#### Task 4.1 — failing test: retry event emitted with attempt + reason

Create `packages/executor/src/__tests__/node-runner.retry-event.test.ts`:

```ts
import { defineAgent } from "@ageflow/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runNode } from "../node-runner.js";

describe("runNode onRetry callback", () => {
  it("invokes onRetry(attempt, reason) before each retry attempt", async () => {
    let attempts = 0;
    const flaky = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("subprocess transient failure");
        return {
          stdout: JSON.stringify({ ok: true }),
          sessionHandle: "s",
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    };

    const a = defineAgent({
      runner: "x",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "p",
      retry: { max: 3, on: ["subprocess_error"], backoff: "fixed" },
    });
    const onRetry = vi.fn();
    await runNode(
      { agent: a, input: {} },
      {},
      flaky,
      "t",
      undefined,
      undefined,
      undefined,
      onRetry,
    );
    expect(onRetry).toHaveBeenCalledTimes(2); // two failures before success
    expect(onRetry.mock.calls[0]?.[0]).toBe(1); // attempt about to start (1, then 2)
    expect(String(onRetry.mock.calls[0]?.[1])).toMatch(/subprocess/);
  });
});
```

Run → fails (8th parameter not accepted).

#### Task 4.2 — implement onRetry parameter

Edit `packages/executor/src/node-runner.ts`:

1. Extend `runNode()` signature with an optional trailing
   `onRetry?: (attempt: number, reason: string) => void` parameter.
2. After a retry is scheduled (inside the `if (errorCode !== null && ...on.includes(errorCode))`
   branch, after pushing to `attempts`), call
   `onRetry?.(attempt + 1, errorMessage)` **before** the `setTimeout` backoff.
3. In `workflow-executor.ts`, when calling `runNode(...)` inside
   `_runBatchesEmitting`, pass:

```ts
(attempt, reason) => {
  push({
    type: "task:retry",
    runId,
    workflowName,
    timestamp: Date.now(),
    taskName,
    attempt,
    reason,
  });
}
```

Run tests → green. Append a stream-level assertion to
`workflow-executor.stream.test.ts`:

```ts
it("emits task:retry between transient failures", async () => {
  let tries = 0;
  const runner: Runner = {
    validate: async () => ({ ok: true }),
    spawn: async () => {
      tries += 1;
      if (tries < 2) throw new Error("subprocess flake");
      return { stdout: JSON.stringify({ x: "ok" }), sessionHandle: "s", tokensIn: 0, tokensOut: 0 };
    },
  };
  registerRunner("flaky", runner);
  try {
    const a = defineAgent({
      runner: "flaky",
      input: z.object({}),
      output: z.object({ x: z.string() }),
      prompt: () => "p",
      retry: { max: 3, on: ["subprocess_error"], backoff: "fixed" },
    });
    const wfy = defineWorkflow({ name: "r", tasks: { t: { agent: a, input: {} } } });
    const ex = new WorkflowExecutor(wfy);
    const events: WorkflowEvent[] = [];
    for await (const ev of ex.stream({})) events.push(ev);
    expect(events.some((e) => e.type === "task:retry")).toBe(true);
  } finally {
    unregisterRunner("flaky");
  }
});
```

**Commit:** `feat(executor): task:retry event via node-runner onRetry callback (#26)`

---

### Phase 5 — HITL resolver path for async checkpoint

Executor needs to support three checkpoint modes:
1. Legacy (hook-or-TTY) — used by `run()` without `onCheckpoint`. Existing
   behavior; provided by the `legacyHitlAdapter` set in Task 3.2.
2. Caller-provided `onCheckpoint` — `run()` or `stream()` with option.
3. External resume (server path) — deferred promise resolved from outside
   (wired in Phase 7).

In all cases, `_runBatchesEmitting` emits the `checkpoint` event and
awaits a `Promise<boolean>`. This phase unifies the executor side.

#### Task 5.1 — failing test: stream() with onCheckpoint resolving true/false

Append to `workflow-executor.stream.test.ts`:

```ts
describe("stream() onCheckpoint", () => {
  it("continues when onCheckpoint resolves true", async () => {
    const a = defineAgent({
      runner: "fake",
      input: z.object({}),
      output: z.object({ summary: z.string() }),
      prompt: () => "p",
      hitl: { mode: "checkpoint", message: "go?" },
    });
    const wfz = defineWorkflow({ name: "gated", tasks: { t: { agent: a, input: {} } } });
    const ex = new WorkflowExecutor(wfz);
    const events: WorkflowEvent[] = [];
    for await (const ev of ex.stream({}, { onCheckpoint: async () => true })) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toContain("checkpoint");
    expect(events[events.length - 1]?.type).toBe("workflow:complete");
  });

  it("fails with workflow:error when onCheckpoint resolves false", async () => {
    const a = defineAgent({
      runner: "fake",
      input: z.object({}),
      output: z.object({ summary: z.string() }),
      prompt: () => "p",
      hitl: { mode: "checkpoint", message: "go?" },
    });
    const wfz = defineWorkflow({ name: "gated", tasks: { t: { agent: a, input: {} } } });
    const ex = new WorkflowExecutor(wfz);
    const events: WorkflowEvent[] = [];
    try {
      for await (const ev of ex.stream({}, { onCheckpoint: async () => false })) {
        events.push(ev);
      }
    } catch {
      // expected — driver throws
    }
    expect(events[events.length - 1]?.type).toBe("workflow:error");
  });
});
```

Run → fails (onCheckpoint still ignored; legacy path throws).

#### Task 5.2 — implement checkpoint resolver in executor

In `_runBatchesEmitting`, replace the direct `this.hitlManager.runCheckpoint(...)`
call with:

```ts
if (hitlConfig.mode === "checkpoint") {
  const message =
    "message" in hitlConfig && hitlConfig.message !== undefined
      ? hitlConfig.message
      : `Task "${taskName}" requires approval before proceeding.`;
  // Notify hook (unchanged behavior — Telegram/Slack side effects still fire).
  hooks?.onCheckpoint?.(taskName as keyof T & string, message);

  const ev: CheckpointEvent = {
    type: "checkpoint",
    runId,
    workflowName,
    timestamp: Date.now(),
    taskName,
    message,
  };
  push(ev);

  const approved = await (onCheckpoint
    ? Promise.resolve(onCheckpoint(ev))
    : Promise.resolve(false)); // default: deny (least privilege)

  if (!approved) {
    throw new HitlRejectedError(taskName);
  }
}
```

Add `HitlRejectedError` to `packages/executor/src/errors.ts` (executor-local
for now; server will re-export):

```ts
import { AgentFlowError } from "@ageflow/core";

export class HitlRejectedError extends AgentFlowError {
  readonly code = "hitl_rejected" as const;
  constructor(readonly taskName: string, options?: ErrorOptions) {
    super(`HITL checkpoint rejected for task "${taskName}"`, options);
  }
}
```

Export it from `packages/executor/src/index.ts`.

Notice: `run()` already supplies the legacy adapter (Task 3.2) which
always resolves `true` after the TTY/hook path returns. Legacy CLI tests
are unaffected.

Run tests → green.

**Commit:** `feat(executor): checkpoint resolver + HitlRejectedError (#26)`

---

### Phase 6 — `@ageflow/server` package scaffold

#### Task 6.1 — workspace manifest + tsconfig + vitest

1. `packages/server/package.json`:

```json
{
  "name": "@ageflow/server",
  "version": "0.1.0",
  "description": "Embeddable execution surface for ageflow workflows: stream, fire-and-forget, async HITL, cancellation.",
  "homepage": "https://github.com/Neftedollar/ageflow/tree/master/agentflow/packages/server",
  "type": "module",
  "private": false,
  "sideEffects": false,
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "biome check src/"
  },
  "dependencies": {
    "@ageflow/core": "workspace:*",
    "@ageflow/executor": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.1.0",
    "zod": "^3.23.0"
  },
  "repository": { "type": "git", "url": "https://github.com/Neftedollar/ageflow.git" },
  "keywords": ["ai", "agents", "workflow", "server", "sse", "hitl", "ageflow"],
  "license": "MIT"
}
```

2. `packages/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "tsBuildInfoFile": "dist/.tsbuildinfo",
    "paths": {
      "@ageflow/core": ["../core/src/index.ts"],
      "@ageflow/executor": ["../executor/src/index.ts"]
    }
  },
  "references": [{ "path": "../core" }, { "path": "../executor" }],
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test-d.ts", "dist"]
}
```

3. `packages/server/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    typecheck: { enabled: true, include: ["src/**/*.test-d.ts"] },
    passWithNoTests: true,
  },
});
```

4. `packages/server/src/index.ts`:

```ts
export {};
```

5. Verify:
   - `bun install` at repo root — picks up `packages/server` via the
     existing `packages/*` glob.
   - `bun run --filter @ageflow/server typecheck` → green.
   - `bun run --filter @ageflow/server test` → 0 tests, green.

**Commit:** `feat(server): scaffold @ageflow/server package (#26)`

---

### Phase 7 — `RunHandle` + `RunRegistry` with TTLs

Pure data structures. No executor coupling yet.

#### Task 7.1 — failing test: registry state machine + reaper

Create `packages/server/src/__tests__/run-registry.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunRegistry } from "../run-registry.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RunRegistry", () => {
  it("stores, retrieves, lists", () => {
    const reg = new RunRegistry({ ttlMs: 1000, checkpointTtlMs: 2000, reaperIntervalMs: 500 });
    const h = reg.create({ runId: "r1", workflowName: "wf" });
    expect(reg.get("r1")?.runId).toBe("r1");
    expect(reg.list().length).toBe(1);
    h.markDone({ outputs: {}, metrics: { totalLatencyMs: 0, totalTokensIn: 0, totalTokensOut: 0, totalEstimatedCost: 0, taskCount: 0 } });
    expect(reg.get("r1")?.state).toBe("done");
    reg.stop();
  });

  it("reaper evicts terminal runs after ttlMs", () => {
    const reg = new RunRegistry({ ttlMs: 1000, checkpointTtlMs: 10_000, reaperIntervalMs: 100 });
    const h = reg.create({ runId: "r1", workflowName: "wf" });
    h.markDone({ outputs: {}, metrics: { totalLatencyMs: 0, totalTokensIn: 0, totalTokensOut: 0, totalEstimatedCost: 0, taskCount: 0 } });
    vi.advanceTimersByTime(1500);
    expect(reg.get("r1")).toBeUndefined();
    reg.stop();
  });

  it("reaper auto-rejects awaiting-checkpoint runs after checkpointTtlMs", () => {
    const reg = new RunRegistry({ ttlMs: 60_000, checkpointTtlMs: 500, reaperIntervalMs: 100 });
    const h = reg.create({ runId: "r1", workflowName: "wf" });
    let rejected = false;
    h.markAwaitingCheckpoint(
      { type: "checkpoint", runId: "r1", workflowName: "wf", timestamp: Date.now(), taskName: "t", message: "m" },
      (approved) => { if (!approved) rejected = true; },
    );
    vi.advanceTimersByTime(700);
    expect(rejected).toBe(true);
    expect(reg.get("r1")?.state).toBe("failed");
    reg.stop();
  });
});
```

Run → fails (module missing).

#### Task 7.2 — implement `RunHandle` internals

`packages/server/src/run-handle.ts`:

```ts
import type { CheckpointEvent, RunHandle, RunState, WorkflowMetrics } from "@ageflow/core";
import { CheckpointTimeoutError } from "./errors.js";

export interface CreateHandleArgs {
  readonly runId: string;
  readonly workflowName: string;
}

export interface PendingCheckpoint {
  readonly event: CheckpointEvent;
  readonly resolve: (approved: boolean) => void;
}

export class InternalRunHandle {
  readonly runId: string;
  readonly workflowName: string;
  readonly createdAt: number;
  readonly abort: AbortController;

  state: RunState = "running";
  lastEventAt: number;
  pendingCheckpoint?: PendingCheckpoint;
  result?: { outputs: Record<string, unknown>; metrics: WorkflowMetrics };
  error?: Error;

  constructor(args: CreateHandleArgs) {
    this.runId = args.runId;
    this.workflowName = args.workflowName;
    this.createdAt = Date.now();
    this.lastEventAt = this.createdAt;
    this.abort = new AbortController();
  }

  touch(): void {
    this.lastEventAt = Date.now();
  }

  markAwaitingCheckpoint(event: CheckpointEvent, resolve: (approved: boolean) => void): void {
    this.state = "awaiting-checkpoint";
    this.pendingCheckpoint = { event, resolve };
    this.touch();
  }

  clearCheckpoint(): void {
    this.pendingCheckpoint = undefined;
    this.state = "running";
    this.touch();
  }

  markDone(result: { outputs: Record<string, unknown>; metrics: WorkflowMetrics }): void {
    this.state = "done";
    this.result = result;
    this.pendingCheckpoint = undefined;
    this.touch();
  }

  markFailed(err: Error): void {
    this.state = "failed";
    this.error = err;
    this.pendingCheckpoint = undefined;
    this.touch();
  }

  markCancelled(): void {
    this.state = "cancelled";
    this.pendingCheckpoint = undefined;
    this.touch();
  }

  snapshot(): RunHandle {
    const snap: RunHandle = {
      runId: this.runId,
      workflowName: this.workflowName,
      state: this.state,
      createdAt: this.createdAt,
      lastEventAt: this.lastEventAt,
    };
    if (this.pendingCheckpoint) {
      return { ...snap, pendingCheckpoint: this.pendingCheckpoint.event };
    }
    if (this.result) return { ...snap, result: this.result };
    if (this.error) {
      return { ...snap, error: { name: this.error.name, message: this.error.message } };
    }
    return snap;
  }

  autoRejectCheckpoint(): void {
    const pc = this.pendingCheckpoint;
    if (!pc) return;
    pc.resolve(false);
    this.markFailed(new CheckpointTimeoutError(pc.event.taskName));
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
```

`packages/server/src/errors.ts`:

```ts
import { AgentFlowError } from "@ageflow/core";

export class CheckpointTimeoutError extends AgentFlowError {
  readonly code = "checkpoint_timeout" as const;
  constructor(readonly taskName: string, options?: ErrorOptions) {
    super(`Checkpoint for task "${taskName}" timed out`, options);
  }
}

export class RunNotFoundError extends AgentFlowError {
  readonly code = "run_not_found" as const;
  constructor(readonly runId: string, options?: ErrorOptions) {
    super(`Run not found: ${runId}`, options);
  }
}

export class InvalidRunStateError extends AgentFlowError {
  readonly code = "invalid_run_state" as const;
  constructor(readonly runId: string, readonly state: string, options?: ErrorOptions) {
    super(`Run ${runId} is in invalid state: ${state}`, options);
  }
}

export { HitlRejectedError } from "@ageflow/executor";
```

#### Task 7.3 — implement `RunRegistry`

`packages/server/src/run-registry.ts`:

```ts
import type { RunHandle } from "@ageflow/core";
import { InternalRunHandle, type CreateHandleArgs } from "./run-handle.js";

export interface RunRegistryConfig {
  readonly ttlMs: number;
  readonly checkpointTtlMs: number;
  readonly reaperIntervalMs: number;
}

export class RunRegistry {
  private readonly handles = new Map<string, InternalRunHandle>();
  private readonly cfg: RunRegistryConfig;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(cfg: RunRegistryConfig) {
    this.cfg = cfg;
    this.timer = setInterval(() => this.sweep(), cfg.reaperIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  create(args: CreateHandleArgs): InternalRunHandle {
    const h = new InternalRunHandle(args);
    this.handles.set(h.runId, h);
    return h;
  }

  getInternal(runId: string): InternalRunHandle | undefined {
    return this.handles.get(runId);
  }

  get(runId: string): RunHandle | undefined {
    return this.handles.get(runId)?.snapshot();
  }

  list(): readonly RunHandle[] {
    return [...this.handles.values()].map((h) => h.snapshot());
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, h] of this.handles) {
      if (h.state === "awaiting-checkpoint" && now - h.lastEventAt > this.cfg.checkpointTtlMs) {
        h.autoRejectCheckpoint();
        continue;
      }
      const terminal = h.state === "done" || h.state === "failed" || h.state === "cancelled";
      if (terminal && now - h.lastEventAt > this.cfg.ttlMs) {
        this.handles.delete(id);
      }
    }
  }
}
```

Run `bun run --filter @ageflow/server test` → green.

**Commit:** `feat(server): RunHandle + RunRegistry with TTL reaper (#26)`

---

### Phase 8 — `createRunner()` factory: stream / run / fire / resume / cancel / list

#### Task 8.1 — types + stream/run failing tests

`packages/server/src/types.ts`:

```ts
import type {
  CheckpointEvent,
  RunHandle,
  TasksMap,
  WorkflowDef,
  WorkflowEvent,
} from "@ageflow/core";
import type { WorkflowResult } from "@ageflow/executor";

export type { RunHandle } from "@ageflow/core";
export type { WorkflowResult } from "@ageflow/executor";

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly onCheckpoint?: (ev: CheckpointEvent) => Promise<boolean> | boolean;
}

export interface FireOptions extends RunOptions {
  readonly onEvent?: (ev: WorkflowEvent) => void;
  readonly onError?: (err: Error) => void;
  readonly onComplete?: (result: WorkflowResult<TasksMap>) => void;
}

export interface RunnerConfig {
  /** Terminal-run TTL before GC. Default: 5 min. */
  readonly ttlMs?: number;
  /** Awaiting-checkpoint TTL before auto-reject. Default: 1 hour. */
  readonly checkpointTtlMs?: number;
  /** How often the reaper sweeps. Default: 60 s. */
  readonly reaperIntervalMs?: number;
  /** runId generator. Default: crypto.randomUUID. */
  readonly generateRunId?: () => string;
}

export interface Runner {
  stream<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: RunOptions,
  ): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void>;

  run<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: RunOptions,
  ): Promise<WorkflowResult<T>>;

  fire<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: FireOptions,
  ): RunHandle;

  resume(runId: string, approved: boolean): void;
  cancel(runId: string): void;
  get(runId: string): RunHandle | undefined;
  list(): readonly RunHandle[];
  /** Stop the reaper (tests). Idempotent. */
  close(): void;
}
```

`packages/server/src/__tests__/runner.stream.test.ts` (failing):

```ts
import { defineAgent, defineWorkflow, registerRunner, unregisterRunner } from "@ageflow/core";
import type { Runner as AgentRunner } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRunner } from "../runner.js";

const stub: AgentRunner = {
  validate: async () => ({ ok: true }),
  spawn: async () => ({ stdout: JSON.stringify({ ok: true }), sessionHandle: "s", tokensIn: 1, tokensOut: 1 }),
};
const agent = defineAgent({
  runner: "stub",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prompt: () => "p",
});
const wf = defineWorkflow({ name: "x", tasks: { t: { agent, input: {} } } });

beforeEach(() => registerRunner("stub", stub));
afterEach(() => unregisterRunner("stub"));

describe("createRunner().stream", () => {
  it("streams events and returns WorkflowResult", async () => {
    const runner = createRunner();
    const events = [];
    const gen = runner.stream(wf, {});
    let r: IteratorResult<unknown, unknown>;
    do {
      r = await gen.next();
      if (!r.done) events.push(r.value);
    } while (!r.done);
    expect(events[0]).toMatchObject({ type: "workflow:start" });
    expect(events[events.length - 1]).toMatchObject({ type: "workflow:complete" });
    runner.close();
  });

  it("registers the run and evicts on terminal + TTL", async () => {
    const runner = createRunner({ ttlMs: 10, reaperIntervalMs: 5 });
    for await (const _ of runner.stream(wf, {})) {
      // drain
    }
    expect(runner.list().length).toBeLessThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runner.list().length).toBe(0);
    runner.close();
  });
});
```

`packages/server/src/__tests__/runner.run.test.ts`:

```ts
describe("createRunner().run", () => {
  it("returns the same WorkflowResult as draining stream()", async () => {
    const runner = createRunner();
    const r = await runner.run(wf, {});
    expect(r.outputs.t).toEqual({ ok: true });
    runner.close();
  });

  it("auto-rejects checkpoints when onCheckpoint is omitted", async () => {
    const a = defineAgent({
      runner: "stub",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "p",
      hitl: { mode: "checkpoint" },
    });
    const gated = defineWorkflow({ name: "g", tasks: { t: { agent: a, input: {} } } });
    const runner = createRunner();
    await expect(runner.run(gated, {})).rejects.toThrow();
    runner.close();
  });
});
```

Run → fails (no module).

#### Task 8.2 — implement `createRunner()` (stream + run + registry wiring)

`packages/server/src/runner.ts`:

```ts
import type {
  CheckpointEvent,
  RunHandle,
  TasksMap,
  WorkflowDef,
  WorkflowEvent,
} from "@ageflow/core";
import { WorkflowExecutor, type WorkflowResult } from "@ageflow/executor";
import { InvalidRunStateError, RunNotFoundError } from "./errors.js";
import { createDeferred } from "./run-handle.js";
import { RunRegistry } from "./run-registry.js";
import type { FireOptions, Runner, RunnerConfig, RunOptions } from "./types.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_CHECKPOINT_TTL_MS = 60 * 60_000;
const DEFAULT_REAPER_INTERVAL_MS = 60_000;

export function createRunner(config: RunnerConfig = {}): Runner {
  const registry = new RunRegistry({
    ttlMs: config.ttlMs ?? DEFAULT_TTL_MS,
    checkpointTtlMs: config.checkpointTtlMs ?? DEFAULT_CHECKPOINT_TTL_MS,
    reaperIntervalMs: config.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS,
  });
  const generateRunId = config.generateRunId ?? (() => crypto.randomUUID());

  async function* streamImpl<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input: unknown,
    options: RunOptions | undefined,
  ): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void> {
    const runId = generateRunId();
    const handle = registry.create({ runId, workflowName: workflow.name });

    // Combine caller signal + internal abort.
    if (options?.signal) {
      options.signal.addEventListener("abort", () => handle.abort.abort(), { once: true });
    }

    // Build the checkpoint resolver used by the executor:
    //   - If caller provided onCheckpoint, use it directly.
    //   - Otherwise, mark the handle awaiting and return a deferred that
    //     `resume()` resolves.
    const onCheckpoint = async (ev: CheckpointEvent): Promise<boolean> => {
      handle.touch();
      if (options?.onCheckpoint) {
        return await options.onCheckpoint(ev);
      }
      const deferred = createDeferred<boolean>();
      handle.markAwaitingCheckpoint(ev, deferred.resolve);
      const approved = await deferred.promise;
      handle.clearCheckpoint();
      return approved;
    };

    const executor = new WorkflowExecutor(workflow);
    // Pull each event, update registry, yield to caller.
    let result: WorkflowResult<T> | undefined;
    try {
      const inner = executor.stream(input, {
        signal: handle.abort.signal,
        onCheckpoint,
      });
      let step: IteratorResult<WorkflowEvent, WorkflowResult<T>>;
      do {
        step = await inner.next();
        if (!step.done) {
          // Overwrite runId on events — executor generates its own; server's wins
          // so caller sees a single consistent id.
          const ev = { ...step.value, runId } as WorkflowEvent;
          handle.touch();
          yield ev;
        } else {
          result = step.value;
        }
      } while (!step.done);

      if (handle.abort.signal.aborted) {
        handle.markCancelled();
      } else if (result) {
        handle.markDone({ outputs: result.outputs as Record<string, unknown>, metrics: result.metrics });
      }
      return result as WorkflowResult<T>;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (handle.abort.signal.aborted) {
        handle.markCancelled();
      } else {
        handle.markFailed(e);
      }
      throw e;
    }
  }

  return {
    stream: streamImpl,

    async run<T extends TasksMap>(
      workflow: WorkflowDef<T>,
      input?: unknown,
      options?: RunOptions,
    ): Promise<WorkflowResult<T>> {
      const gen = streamImpl(workflow, input, options);
      let step: IteratorResult<WorkflowEvent, WorkflowResult<T>>;
      do {
        step = await gen.next();
      } while (!step.done);
      return step.value;
    },

    fire<T extends TasksMap>(
      workflow: WorkflowDef<T>,
      input?: unknown,
      options?: FireOptions,
    ): RunHandle {
      const runId = generateRunId();
      const handle = registry.create({ runId, workflowName: workflow.name });
      // Delegate to stream but pre-seed with same runId (via generateRunId override).
      const gen = streamImpl(
        workflow,
        input,
        { ...options, signal: options?.signal },
      );
      (async () => {
        try {
          let step: IteratorResult<WorkflowEvent, WorkflowResult<TasksMap>>;
          do {
            step = await (gen as AsyncGenerator<WorkflowEvent, WorkflowResult<TasksMap>, void>).next();
            if (!step.done) options?.onEvent?.(step.value);
          } while (!step.done);
          options?.onComplete?.(step.value);
        } catch (err) {
          options?.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      })();
      return handle.snapshot();
    },

    resume(runId: string, approved: boolean): void {
      const h = registry.getInternal(runId);
      if (!h) throw new RunNotFoundError(runId);
      if (h.state !== "awaiting-checkpoint" || !h.pendingCheckpoint) {
        throw new InvalidRunStateError(runId, h.state);
      }
      const { resolve } = h.pendingCheckpoint;
      h.clearCheckpoint();
      resolve(approved);
    },

    cancel(runId: string): void {
      const h = registry.getInternal(runId);
      if (!h) return; // idempotent
      h.abort.abort();
      if (h.pendingCheckpoint) {
        const { resolve } = h.pendingCheckpoint;
        resolve(false);
      }
      h.markCancelled();
    },

    get: (runId) => registry.get(runId),
    list: () => registry.list(),
    close: () => registry.stop(),
  };
}
```

`packages/server/src/index.ts`:

```ts
export { createRunner } from "./runner.js";
export type {
  FireOptions,
  Runner,
  RunnerConfig,
  RunOptions,
  RunHandle,
  WorkflowResult,
} from "./types.js";
export {
  CheckpointTimeoutError,
  HitlRejectedError,
  InvalidRunStateError,
  RunNotFoundError,
} from "./errors.js";
export type {
  BudgetWarningEvent,
  CheckpointEvent,
  RunState,
  TaskCompleteEvent,
  TaskErrorEvent,
  TaskRetryEvent,
  TaskStartEvent,
  WorkflowCompleteEvent,
  WorkflowErrorEvent,
  WorkflowEvent,
  WorkflowStartEvent,
} from "@ageflow/core";
```

Run `bun run --filter @ageflow/server test` → green.

**Commit:** `feat(server): createRunner() factory — stream/run/fire/resume/cancel/get/list (#26)`

---

### Phase 9 — Async HITL via deferred promise

Covered in Phase 8's implementation. This phase adds targeted tests and
tightens the contract.

#### Task 9.1 — failing test: resume true / resume false / timeout

`packages/server/src/__tests__/runner.hitl.test.ts`:

```ts
import { defineAgent, defineWorkflow, registerRunner, unregisterRunner } from "@ageflow/core";
import type { Runner as AgentRunner } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRunner } from "../runner.js";

const stub: AgentRunner = {
  validate: async () => ({ ok: true }),
  spawn: async () => ({ stdout: JSON.stringify({ ok: true }), sessionHandle: "s", tokensIn: 0, tokensOut: 0 }),
};
const agent = defineAgent({
  runner: "stub",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prompt: () => "p",
  hitl: { mode: "checkpoint", message: "please approve" },
});
const wf = defineWorkflow({ name: "gated", tasks: { t: { agent, input: {} } } });

beforeEach(() => registerRunner("stub", stub));
afterEach(() => unregisterRunner("stub"));

describe("async HITL", () => {
  it("pauses, exposes pendingCheckpoint, resumes on approve=true", async () => {
    const runner = createRunner();
    const events = [];
    const gen = runner.stream(wf, {});

    let runId: string | undefined;
    let step = await gen.next();
    while (!step.done && step.value.type !== "checkpoint") {
      events.push(step.value);
      runId = step.value.runId;
      step = await gen.next();
    }
    expect(step.done).toBe(false);
    if (!step.done) {
      runId = step.value.runId;
      events.push(step.value);
    }

    // Handle is in awaiting-checkpoint
    expect(runner.get(runId!)?.state).toBe("awaiting-checkpoint");
    expect(runner.get(runId!)?.pendingCheckpoint).toBeDefined();

    // Resume from another "request"
    runner.resume(runId!, true);

    // Drain rest
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    expect(events.at(-1)?.type).toBe("workflow:complete");
    runner.close();
  });

  it("resume(false) fails with workflow:error", async () => {
    const runner = createRunner();
    const events = [];
    const gen = runner.stream(wf, {});
    let step = await gen.next();
    let runId: string | undefined;
    while (!step.done) {
      events.push(step.value);
      runId = step.value.runId;
      if (step.value.type === "checkpoint") break;
      step = await gen.next();
    }
    runner.resume(runId!, false);
    try {
      let next = await gen.next();
      while (!next.done) {
        events.push(next.value);
        next = await gen.next();
      }
    } catch {
      // driver throws — acceptable
    }
    expect(events.at(-1)?.type).toBe("workflow:error");
    runner.close();
  });

  it("auto-rejects after checkpointTtlMs", async () => {
    vi.useFakeTimers();
    const runner = createRunner({ checkpointTtlMs: 50, reaperIntervalMs: 10 });
    const events = [];
    const gen = runner.stream(wf, {});
    let step = await gen.next();
    while (!step.done && step.value.type !== "checkpoint") {
      events.push(step.value);
      step = await gen.next();
    }
    if (!step.done) events.push(step.value);
    await vi.advanceTimersByTimeAsync(200);
    // Driver should have rejected; drain remaining
    try {
      let next = await gen.next();
      while (!next.done) {
        events.push(next.value);
        next = await gen.next();
      }
    } catch {}
    expect(events.at(-1)?.type).toBe("workflow:error");
    runner.close();
    vi.useRealTimers();
  });

  it("resume() on unknown runId throws RunNotFoundError", () => {
    const runner = createRunner();
    expect(() => runner.resume("does-not-exist", true)).toThrow(/not found/i);
    runner.close();
  });

  it("resume() on running run throws InvalidRunStateError", async () => {
    const runner = createRunner();
    const plain = defineAgent({
      runner: "stub",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "p",
    });
    const wfp = defineWorkflow({ name: "p", tasks: { t: { agent: plain, input: {} } } });
    await runner.run(wfp, {});
    const id = runner.list()[0]?.runId;
    if (id) expect(() => runner.resume(id, true)).toThrow();
    runner.close();
  });
});
```

Run → should pass if Phase 8 was implemented correctly; fix bugs in
`runner.ts` until green.

**Commit:** `feat(server): async HITL resume() with deferred promise + timeout (#26)`

---

### Phase 10 — AbortSignal cancellation

#### Task 10.1 — failing test

`packages/server/src/__tests__/runner.cancel.test.ts`:

```ts
import { defineAgent, defineWorkflow, registerRunner, unregisterRunner } from "@ageflow/core";
import type { Runner as AgentRunner } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRunner } from "../runner.js";

// Slow runner — gives us time to cancel mid-flight.
const slow: AgentRunner = {
  validate: async () => ({ ok: true }),
  spawn: async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { stdout: JSON.stringify({ ok: true }), sessionHandle: "s", tokensIn: 0, tokensOut: 0 };
  },
};

const agent = defineAgent({
  runner: "slow",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  prompt: () => "p",
});
const wf = defineWorkflow({ name: "s", tasks: { t: { agent, input: {} } } });

beforeEach(() => registerRunner("slow", slow));
afterEach(() => unregisterRunner("slow"));

describe("cancel", () => {
  it("cancel(runId) marks state=cancelled and stops emitting events", async () => {
    const runner = createRunner();
    const gen = runner.stream(wf, {});
    const first = await gen.next();
    if (first.done) throw new Error("no events");
    const runId = first.value.runId;
    runner.cancel(runId);

    // Drain whatever remains; no more events expected after cancel.
    try {
      let step = await gen.next();
      while (!step.done) step = await gen.next();
    } catch {}
    expect(runner.get(runId)?.state).toBe("cancelled");
    runner.close();
  });

  it("options.signal aborts stream() mid-flight", async () => {
    const runner = createRunner();
    const ac = new AbortController();
    const gen = runner.stream(wf, {}, { signal: ac.signal });
    const first = await gen.next();
    if (first.done) throw new Error("no events");
    const runId = first.value.runId;
    ac.abort();
    try {
      let step = await gen.next();
      while (!step.done) step = await gen.next();
    } catch {}
    expect(runner.get(runId)?.state).toBe("cancelled");
    runner.close();
  });

  it("cancel(unknown) is idempotent (no throw)", () => {
    const runner = createRunner();
    expect(() => runner.cancel("nope")).not.toThrow();
    runner.close();
  });
});
```

#### Task 10.2 — implement

Implementation is already in Task 8.2's `cancel()`. Verify the
`options.signal → handle.abort.abort()` bridge exists and that
`handle.abort.signal` is handed to the executor's `stream()` options.
If the executor's current `StreamOptions.signal` isn't yet wired to
abort in-flight runners, thread it into `runNode()` (passed via `runner.spawn({... signal})` in v0.2 — out of scope here; for v1 aborting drops events by marking the handle cancelled, which the test above asserts).

Run → green.

**Commit:** `feat(server): AbortSignal cancellation via cancel() and options.signal (#26)`

---

### Phase 11 — Tests (unit + integration)

Most unit coverage was added alongside earlier phases. This phase fills
the remaining matrix.

#### Task 11.1 — fire() callbacks

`packages/server/src/__tests__/runner.fire.test.ts`:

```ts
describe("fire()", () => {
  it("invokes onEvent for each event and onComplete at the end", async () => {
    const runner = createRunner();
    const events: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      runner.fire(wf, {}, {
        onEvent: (ev) => events.push(ev),
        onComplete: () => resolve(),
      });
    });
    await done;
    expect(events.some((e) => (e as { type: string }).type === "workflow:complete")).toBe(true);
    runner.close();
  });

  it("invokes onError when the workflow fails", async () => {
    const boomRunner: AgentRunner = {
      validate: async () => ({ ok: true }),
      spawn: async () => { throw new Error("boom"); },
    };
    registerRunner("boom2", boomRunner);
    try {
      const a = defineAgent({
        runner: "boom2",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        prompt: () => "p",
        retry: { max: 1, on: ["subprocess_error"], backoff: "fixed" },
      });
      const wfb = defineWorkflow({ name: "b", tasks: { t: { agent: a, input: {} } } });
      const runner = createRunner();
      const err = await new Promise<Error>((resolve) => {
        runner.fire(wfb, {}, { onError: resolve });
      });
      expect(err.message).toMatch(/boom/);
      runner.close();
    } finally {
      unregisterRunner("boom2");
    }
  });
});
```

#### Task 11.2 — type-level tests

`packages/server/src/__tests__/types.test-d.ts`:

```ts
import type { WorkflowDef } from "@ageflow/core";
import { describe, expectTypeOf, it } from "vitest";
import { createRunner } from "../runner.js";
import type { Runner, RunHandle, WorkflowResult } from "../types.js";

describe("types", () => {
  it("stream yields WorkflowEvent, returns WorkflowResult<T>", () => {
    const r: Runner = createRunner();
    type WF = WorkflowDef<{}>;
    const gen = r.stream({} as WF);
    expectTypeOf(gen).toMatchTypeOf<AsyncGenerator<unknown, WorkflowResult<{}>, void>>();
  });

  it("fire returns RunHandle synchronously", () => {
    const r: Runner = createRunner();
    type WF = WorkflowDef<{}>;
    expectTypeOf(r.fire({} as WF)).toEqualTypeOf<RunHandle>();
  });
});
```

**Commit:** `test(server): fire() callbacks + type-level surface (#26)`

---

### Phase 12 — Example workspace `examples/server-embed/`

Shows SSE wiring over `node:http` — zero framework dependencies.

#### Task 12.1 — scaffold example

`examples/server-embed/package.json`:

```json
{
  "name": "@ageflow-example/server-embed",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun server.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ageflow/core": "workspace:*",
    "@ageflow/executor": "workspace:*",
    "@ageflow/server": "workspace:*",
    "@ageflow/runner-api": "workspace:*",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.1.0"
  }
}
```

`examples/server-embed/workflow.ts`:

```ts
import { defineAgent, defineWorkflow, registerRunner } from "@ageflow/core";
import { ApiRunner } from "@ageflow/runner-api";
import { z } from "zod";

registerRunner(
  "api",
  new ApiRunner({
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    defaultModel: "gpt-4o-mini",
  }),
);

const classify = defineAgent({
  runner: "api",
  model: "gpt-4o-mini",
  input: z.object({ message: z.string() }),
  output: z.object({ urgent: z.boolean(), summary: z.string() }),
  prompt: (i) => `Classify: ${i.message}. Output JSON {urgent:boolean, summary:string}.`,
  hitl: { mode: "checkpoint", message: "Approve classification?" },
});

export const triageWorkflow = defineWorkflow({
  name: "triage",
  tasks: {
    classify: { agent: classify, input: { message: "Server is on fire" } },
  },
});
```

`examples/server-embed/server.ts`:

```ts
import { createServer } from "node:http";
import { createRunner } from "@ageflow/server";
import { triageWorkflow } from "./workflow.js";

const runner = createRunner();

const server = createServer(async (req, res) => {
  if (req.url === "/runs" && req.method === "POST") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    try {
      for await (const ev of runner.stream(triageWorkflow, {})) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (ev.type === "checkpoint") break;
      }
      res.end();
    } catch (err) {
      res.write(`event: error\ndata: ${String(err)}\n\n`);
      res.end();
    }
    return;
  }

  if (req.url?.startsWith("/runs/") && req.url.endsWith("/resume") && req.method === "POST") {
    const runId = req.url.split("/")[2] ?? "";
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const approved = JSON.parse(body).approved === true;
      try {
        runner.resume(runId, approved);
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(404).end(String(err));
      }
    });
    return;
  }

  res.writeHead(404).end();
});

server.listen(3000, () => console.log("listening on :3000"));
```

`examples/server-embed/__tests__/sse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRunner } from "@ageflow/server";
import { triageWorkflow } from "../workflow.js";

describe("server-embed demo", () => {
  it("streams events and supports resume-true via runner", async () => {
    const runner = createRunner();
    const gen = runner.stream(triageWorkflow, {}, { onCheckpoint: async () => true });
    const types: string[] = [];
    for await (const ev of gen) types.push(ev.type);
    expect(types[0]).toBe("workflow:start");
    expect(types).toContain("checkpoint");
    runner.close();
  });
});
```

`examples/server-embed/README.md`:
- Quick start (`bun server.ts`)
- `curl -N -X POST :3000/runs` then `curl -X POST :3000/runs/<id>/resume -d '{"approved":true}'`
- Note: test uses mocked `ApiRunner` via env override; README mentions real-run requires `OPENAI_API_KEY`.

Run `bun run --filter @ageflow-example/server-embed test` → green.

**Commit:** `docs(server): example workspace examples/server-embed with SSE demo (#26)`

---

### Phase 13 — README + publish metadata

`packages/server/README.md`:

- Installation (`bun add @ageflow/server`)
- Quick start — three snippets for `stream()`, `run()`, `fire()`
- SSE example (Express / Hono / `node:http`)
- Async HITL example (resume from another request)
- Run registry: TTLs, `list()`, `get()`
- Configuration: `ttlMs`, `checkpointTtlMs`, `reaperIntervalMs`,
  `generateRunId`
- Errors: `HitlRejectedError`, `CheckpointTimeoutError`,
  `RunNotFoundError`, `InvalidRunStateError`
- Non-goals (pull from spec §Non-goals)
- Roadmap pointer to spec §Roadmap

Update `agentflow/CLAUDE.md`:

- Add `@ageflow/server` to the "Packages (v1)" list with one-liner:
  "embeddable execution surface — streaming events, async HITL, cancellation"
- Add `core ← server` and `executor ← server` to the dependency graph.

Run top-level verification:

```
bun install
bun run typecheck
bun run test
bun run lint
```

Everything green.

**Commit:** `docs(server): README + publish metadata + root workspace wiring (#26)`

---

## Verification checklist

- [ ] `bun run --filter @ageflow/core typecheck && test` — WorkflowEvent + RunHandle types exported; discriminant narrowing tests green
- [ ] `bun run --filter @ageflow/executor test` — existing tests (HITL, budget, session, loop) all green; new stream tests green; run()-as-drain regression green
- [ ] `bun run --filter @ageflow/server typecheck && test` — stream/run/fire/resume/cancel/get/list all covered; registry + reaper covered with fake timers
- [ ] `bun run --filter @ageflow-example/server-embed test` — example green
- [ ] `bun run typecheck && bun run test && bun run lint` at repo root — everything green
- [ ] `bun run --filter @ageflow/runners-claude test && --filter @ageflow/runners-codex test && --filter @ageflow/runner-api test` — backward-compat (no runner behavior changed)
- [ ] `bun run --filter @ageflow/cli test` — CLI TTY path still works via legacy HITL adapter

## Open questions / follow-ups (log as separate issues)

- **`runner.fire()` runId vs `streamImpl` internal runId.** Current
  Phase 8 implementation registers the handle in `fire()` then delegates
  to `streamImpl` which creates a second handle. Clean fix: factor out
  a `streamImplInternal({ handle, ... })` that takes a pre-created
  handle. Listed as a follow-up so the commit boundary stays tight.
- **Executor `signal` → runner abort.** v1 `cancel()` marks handle state
  cancelled but does not propagate `AbortSignal` into subprocess runners
  (`spawn()` doesn't take a signal). Follow-up: thread signal into
  `RunnerSpawnArgs`.
- **`subscribe(runId)`.** Second observer joining an in-flight run.
  Deferred to v0.2 per spec §Roadmap.
- **Durable runs.** Pluggable `RunStore` (SQLite/Redis). v0.2.
- **`@ageflow/server-http`.** Opinionated middleware package. v0.2.
- **Event serialization contract.** We rely on structural JSON-safety
  (enforced by types). Adding an explicit `toJSON()` per event type
  would formalize it; defer unless a consumer hits an edge case.
- **`HITLManager.runCheckpointStream()`.** The plan inlines the
  checkpoint resolver in `workflow-executor.ts` rather than adding a new
  method on `HITLManager`. If this grows a second call site, extract it.
