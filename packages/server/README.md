# `@ageflow/server`

Embeddable execution surface for [AgentFlow](https://github.com/Neftedollar/ageflow) workflows.

- **Stream** structured `WorkflowEvent`s — wire to SSE, WebSocket, or JSONL yourself
- **Async HITL** — pause a run, expose a `pendingCheckpoint`, resume from any request
- **Fire-and-forget** — background runs with `onEvent` / `onComplete` / `onError` callbacks
- **Cancellation** — `AbortSignal` + `cancel(runId)` via a built-in run registry
- **Zero HTTP dependency** — bring your own Express, Hono, Fastify, Next.js, or raw `node:http`

---

## Installation

```bash
bun add @ageflow/server @ageflow/core @ageflow/executor
# or
npm install @ageflow/server @ageflow/core @ageflow/executor
```

---

## Quick start

### `stream()` — consume events one by one

```ts
import { createRunner } from "@ageflow/server";
import { myWorkflow } from "./workflows.js";

const runner = createRunner();

for await (const ev of runner.stream(myWorkflow, { userId: "u1" })) {
  console.log(ev.type, ev);
  // workflow:start | task:start | task:complete | checkpoint | workflow:complete …
}
```

### `run()` — await the final result

```ts
const result = await runner.run(myWorkflow, { userId: "u1" });
console.log(result.outputs); // { taskName: outputObject, … }
```

> `run()` auto-rejects HITL checkpoints by default (least-privilege). Pass
> `onCheckpoint` to handle them inline.

### `fire()` — background run, synchronous handle

```ts
const handle = runner.fire(myWorkflow, { userId: "u1" }, {
  onEvent: (ev) => console.log("event", ev.type),
  onComplete: (result) => console.log("done", result.outputs),
  onError: (err) => console.error("failed", err),
});

console.log(handle.runId); // available immediately
```

---

## SSE example (`node:http`)

```ts
import { createServer } from "node:http";
import { createRunner } from "@ageflow/server";
import { triageWorkflow } from "./workflows.js";

const runner = createRunner();

createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/runs") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    for await (const ev of runner.stream(triageWorkflow, {})) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (ev.type === "checkpoint") break; // pause; client will resume later
    }
    res.end();
  }
}).listen(3000);
```

### Hono

```ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createRunner } from "@ageflow/server";

const app = new Hono();
const runner = createRunner();

app.post("/runs", (c) =>
  streamSSE(c, async (stream) => {
    for await (const ev of runner.stream(myWorkflow, {})) {
      await stream.writeSSE({ data: JSON.stringify(ev) });
    }
  }),
);
```

### Express

```ts
import express from "express";
import { createRunner } from "@ageflow/server";

const app = express();
const runner = createRunner();

app.post("/runs", async (req, res) => {
  res.setHeader("content-type", "text/event-stream");
  for await (const ev of runner.stream(myWorkflow, req.body)) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
});
```

---

## Async HITL example

Start a run (SSE handler breaks on `checkpoint`):

```bash
curl -N -X POST http://localhost:3000/runs
# data: {"type":"checkpoint","runId":"abc123","message":"Approve output?", ...}
```

Resume from a second request:

```ts
app.post("/runs/:id/resume", express.json(), (req, res) => {
  runner.resume(req.params.id, req.body.approved === true);
  res.sendStatus(204);
});
```

```bash
curl -X POST http://localhost:3000/runs/abc123/resume \
  -H 'content-type: application/json' \
  -d '{"approved":true}'
```

The paused `stream()` generator will unblock and continue emitting events.

---

## Run registry: TTLs, `list()`, `get()`

`createRunner()` maintains an in-memory registry of all active runs.

```ts
const runner = createRunner({
  ttlMs: 5 * 60_000,          // terminal runs evicted after 5 min (default)
  checkpointTtlMs: 60 * 60_000, // awaiting-checkpoint runs auto-rejected after 1 h (default)
  reaperIntervalMs: 60_000,    // reaper sweep interval (default)
});

runner.list();                 // readonly RunHandle[]
runner.get("abc123");          // RunHandle | undefined
```

`RunHandle` shape:

```ts
interface RunHandle {
  runId: string;
  state: "running" | "awaiting-checkpoint" | "done" | "failed" | "cancelled";
  workflowName: string;
  createdAt: number;          // Date.now()
  lastEventAt: number;
  pendingCheckpoint?: CheckpointEvent; // only when state === "awaiting-checkpoint"
  result?: { outputs: Record<string, unknown>; metrics: WorkflowMetrics };
  error?: { name: string; message: string };
}
```

---

## Configuration

```ts
interface RunnerConfig {
  /** TTL (ms) before terminal runs are evicted. Default: 300 000 (5 min). */
  ttlMs?: number;
  /** TTL (ms) before awaiting-checkpoint runs are auto-rejected. Default: 3 600 000 (1 h). */
  checkpointTtlMs?: number;
  /** Reaper sweep interval (ms). Default: 60 000. */
  reaperIntervalMs?: number;
  /** Custom runId generator. Default: crypto.randomUUID(). */
  generateRunId?: () => string;
}
```

---

## Cancellation

```ts
// Via AbortController
const ac = new AbortController();
for await (const ev of runner.stream(wf, {}, { signal: ac.signal })) {
  if (shouldStop) ac.abort();
}

// Via registry (fire-and-forget, or from a different request)
runner.cancel(runId); // idempotent — no-op if unknown
```

---

## `RunOptions` and `FireOptions`

```ts
interface RunOptions {
  signal?: AbortSignal;
  /** Return true to approve, false to reject. If omitted, stream() pauses (async HITL). */
  onCheckpoint?: (ev: CheckpointEvent) => Promise<boolean> | boolean;
}

interface FireOptions extends RunOptions {
  onEvent?: (ev: WorkflowEvent) => void;
  onError?: (err: Error) => void;
  onComplete?: (result: WorkflowResult) => void;
}
```

---

## Errors

| Class | Code | When |
|-------|------|------|
| `HitlRejectedError` | `hitl_rejected` | Checkpoint was rejected (`approved=false`) |
| `CheckpointTimeoutError` | `checkpoint_timeout` | `checkpointTtlMs` expired |
| `RunNotFoundError` | `run_not_found` | `resume()` called with unknown `runId` |
| `InvalidRunStateError` | `invalid_run_state` | `resume()` called on a non-awaiting-checkpoint run |

All errors extend `AgentFlowError` from `@ageflow/core`.

---

## Non-goals

- **No bundled HTTP middleware.** Turning events into SSE / WebSocket / JSONL
  is the caller's responsibility. A separate `@ageflow/server-http` package may
  ship in v0.2.
- **In-memory by default; persistence is pluggable.** The run registry
  keeps active handles in-process. When a durable `RunStore` is provided,
  run snapshots can survive restart and be hydrated by higher layers.
- **No distributed runs.** Single-process only.
- **No `subscribe(runId)`.** Joining an in-flight run from a second observer
  is deferred to v0.2.

---

## Roadmap

See the [design spec](../../docs/superpowers/specs/2026-04-16-server-execution-design.md)
§Roadmap for planned v0.2 and v0.3 features.
