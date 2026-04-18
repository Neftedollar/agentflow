# @ageflow/core

[![npm](https://img.shields.io/npm/v/@ageflow/core)](https://www.npmjs.com/package/@ageflow/core)

Core DSL for [ageflow](../../README.md) — types, Zod schemas, and builders for defining agents and workflows.

## Install

```bash
bun add @ageflow/core zod
```

## API

### `defineAgent(def)`

Define a typed agent. The `input` and `output` Zod schemas are the contract — ageflow validates every call.

```ts
import { defineAgent } from "@ageflow/core";
import { z } from "zod";

const summaryAgent = defineAgent({
  runner: "claude",            // matches a registered Runner
  model: "claude-sonnet-4-6",
  input: z.object({
    text: z.string(),
    maxWords: z.number().optional(),
  }),
  output: z.object({
    summary: z.string(),
    wordCount: z.number(),
  }),
  prompt: ({ text, maxWords }) =>
    `Summarize in ${maxWords ?? 100} words:\n\n${text}`,
});
```

### `defineWorkflow(def)`

Compose agents into a DAG. Tasks with no `dependsOn` run in parallel.

```ts
import { defineWorkflow } from "@ageflow/core";

export default defineWorkflow({
  name: "summarize-and-translate",
  tasks: {
    summarize: {
      agent: summaryAgent,
      input: { text: "...", maxWords: 50 },
    },
    translate: {
      agent: translateAgent,
      dependsOn: ["summarize"],   // runs after summarize
      input: (ctx) => ({
        text: ctx.summarize.output.summary,
        targetLang: "es",
      }),
    },
  },
});
```

### `loop(def)`

Run a sub-workflow repeatedly until a condition is met.

```ts
import { loop } from "@ageflow/core";

const refineLoop = loop({
  dependsOn: ["draft"] as const,
  max: 5,
  until: (ctx) => ctx.grade?.output?.score >= 9,
  tasks: {
    improve: { agent: improveAgent, dependsOn: [], input: ... },
    grade:   { agent: gradeAgent,   dependsOn: ["improve"], input: ... },
  },
});
```

## Deterministic steps with `defineFunction`

Not every task in a workflow is an LLM call. Use `defineFunction` to put a deterministic, non-LLM step in the DAG — fetching data, transforming JSON, validating, persisting. It participates in the DAG like an agent: `dependsOn`, `skipIf`, retry, loop, event emission, Zod validation in and out.

```ts
import { z } from "zod";
import { defineFunction, defineWorkflow } from "@ageflow/core";

const snapshotStep = defineFunction({
  input: z.object({ userId: z.string() }),
  output: z.object({ orders: z.array(z.any()), total: z.number() }),
  execute: async (input) => {
    const orders = await db.orders.findAll({ userId: input.userId });
    return { orders, total: orders.reduce((s, o) => s + o.amount, 0) };
  },
});

const wf = defineWorkflow({
  name: "orders-recap",
  tasks: {
    snapshot: { fn: snapshotStep, input: (ctx) => ({ userId: "u1" }) },
    interpret: {
      agent: interpretAgent,
      dependsOn: ["snapshot"],
      input: (ctx) => ({ snapshot: ctx.snapshot.output }),
    },
    persist: {
      fn: persistStep,
      dependsOn: ["interpret"],
      input: (ctx) => ({ insights: ctx.interpret.output }),
    },
  },
});
```

### Differences from agent tasks

- No runner, no token usage, no budget accounting — cost metrics are always 0.
- No session — fn tasks cannot participate in session sharing.
- Retries: fn tasks honor `retry.on` the same as agent tasks. Errors from `execute()` are classified as `"transient"` (generic) or `"timeout"` (`TimeoutError`). To retry, include the matching kind in `retry.on` (e.g. `on: ["transient"]`). Zod validation errors (input or output) never retry regardless of config — the data contract is wrong and retrying won't fix it.
- Preflight: agent-specific checks (runner brand, session cross-provider, MCP config) skip fn tasks. Topology checks still apply.

### `sessionToken(name, runner)`

Share conversation context between agents. Both agents send messages to the same model session.

```ts
import { sessionToken } from "@ageflow/core";

const sharedCtx = sessionToken("my-session", "claude");

// Use in agent definitions:
const agentA = defineAgent({ ..., session: sharedCtx });
const agentB = defineAgent({ ..., session: sharedCtx }); // same conversation
```

### `registerRunner(name, runner)` / `getRunner(name)`

Register CLI subprocess runners before running a workflow.

```ts
import { registerRunner } from "@ageflow/core";
import { ClaudeRunner } from "@ageflow/runner-claude";

registerRunner("claude", new ClaudeRunner());
```

### `safePath`

Zod refinement that rejects path traversal (`../`, absolute paths). Use it on any file path input.

```ts
import { safePath } from "@ageflow/core";
import { z } from "zod";

const input = z.object({
  filePath: z.string().superRefine(safePath),
});
```

### `CtxFor<Tasks, TaskName>`

Type-safe context accessor — infer the exact output type of upstream tasks.

```ts
import type { CtxFor } from "@ageflow/core";

type MyCtx = CtxFor<WorkflowTasks, "summarize">;
// → { draft: { output: DraftOutput }, translate: { output: TranslateOutput } }
```

## ctx in task-input-callbacks

The `ctx` argument passed to a task's `input` function contains **only the outputs of completed tasks from earlier batches** in the current workflow. It is a flat map keyed by task name.

```ts
ctx.summarize.output  // output of the "summarize" task
ctx.translate.output  // output of the "translate" task
```

Two things `ctx` does NOT contain:

- **Workflow-level input** — the value passed to `executor.stream(input)` is emitted as the `workflow:start` event but is not injected into `ctx`. Use the **closure pattern** to pass workflow-level data into tasks:

```ts
import { WorkflowExecutor } from "@ageflow/executor";

// Closure pattern: wrap defineWorkflow in a factory function
function buildWorkflow(input: { text: string; targetLang: string }) {
  return defineWorkflow({
    name: "translate-pipeline",
    tasks: {
      summarize: {
        agent: summaryAgent,
        // Close over `input` from the outer function
        input: { text: input.text, maxWords: 50 },
      },
      translate: {
        agent: translateAgent,
        dependsOn: ["summarize"],
        input: (ctx) => ({
          // Prior task output from ctx
          text: ctx.summarize.output as string,
          // Workflow-level data from closure
          targetLang: input.targetLang,
        }),
      },
    },
  });
}

const workflow = buildWorkflow({ text: "...", targetLang: "es" });
const executor = new WorkflowExecutor(workflow);
await executor.run();
```

See also [`defineWorkflowFactory`](#defineworkflowfactoryi) — a helper that codifies this closure pattern.

- **Special keys like `$input`, `$parent`, or `$prev`** — these do not exist. See below for loop-specific context access.

## `defineWorkflowFactory<I>`

A typed helper that codifies the [closure pattern](#ctx-in-task-input-callbacks) shown above. Instead of manually writing a factory function, pass the config-builder callback to `defineWorkflowFactory` and get back a typed factory function.

```ts
// Before (manual factory):
export function createPipeline(input: PipelineInput): WorkflowDef {
  return defineWorkflow({
    name: "pipeline",
    tasks: {
      analyze: { agent: analyzeAgent, input: { repoPath: input.repoPath } },
    },
  });
}

// After (using helper):
export const createPipeline = defineWorkflowFactory<PipelineInput>(
  (input) => ({
    name: "pipeline",
    tasks: {
      analyze: { agent: analyzeAgent, input: { repoPath: input.repoPath } },
    },
  }),
);
```

Both produce an identical `WorkflowDef`. The helper version:
- enforces the return type automatically (no manual `: WorkflowDef<...>` annotation needed)
- makes the factory-closure pattern visible at a glance
- is compatible with any consumer that calls `createPipeline(input)`

## Accessing outer ctx and previous iteration inside loop

Inside a `loop`, the inner task `ctx` is built as follows:

1. **Outer workflow's completed-task outputs** are flat-merged into the inner ctx. Access them the same way as any other task output — by their task name:

```ts
// Outer task named "draft" → available as ctx.draft inside the loop
ctx.draft.output  // NOT ctx.$parent.draft
```

2. **Previous iteration's output** is available at `ctx.__loop_feedback__?.output` starting from the second iteration. It is `undefined` on the first iteration.

```ts
ctx.__loop_feedback__?.output  // NOT ctx.$prev
```

Example — a loop that uses the previous iteration's verify-gate reason to refine the build prompt:

```ts
import { loop, defineWorkflow } from "@ageflow/core";

export default defineWorkflow({
  name: "build-verify-loop",
  tasks: {
    scaffold: {
      agent: scaffoldAgent,
      input: { spec: "..." },
    },
    refine: loop({
      dependsOn: ["scaffold"],
      max: 5,
      until: (ctx: unknown) => {
        const c = ctx as Record<string, { output: { passed: boolean } }>;
        return c.verify?.output?.passed === true;
      },
      tasks: {
        build: {
          agent: buildAgent,
          dependsOn: [],
          input: (ctx) => {
            // Outer workflow's "scaffold" output is flat-merged into inner ctx
            const spec = (ctx as Record<string, { output: { code: string } }>)
              .scaffold?.output?.code ?? "";
            // Previous iteration's full output is at __loop_feedback__.output,
            // which is a task-name-keyed map: Record<string, { output, _source }>
            const feedback = (
              ctx as Record<string, { output: Record<string, { output: unknown }> }>
            ).__loop_feedback__?.output;
            const prevReason = (feedback?.verify?.output as { reason?: string } | undefined)
              ?.reason;
            return {
              spec,
              refinementHint: prevReason ?? "First attempt — build from spec.",
            };
          },
        },
        verify: {
          agent: verifyAgent,
          dependsOn: ["build"],
          input: (ctx) => ({
            code: (ctx as Record<string, { output: { code: string } }>)
              .build.output.code,
          }),
        },
      },
    }),
  },
});
```

> **Note on types**: `__loop_feedback__` is not part of `BoundCtx<D>` — cast `ctx` to `unknown` or use a type assertion when accessing it. A typed helper will be added in a future version.

> **See also**: canonical `__loop_feedback__` usage in [`dogfooding/workflow.ts`](../../dogfooding/workflow.ts) and [`examples/bug-fix-pipeline/workflow.ts`](../../examples/bug-fix-pipeline/workflow.ts).

## Error types

All errors extend `AgentFlowError`. Import individually or catch by base class:

```ts
import {
  BudgetExceededError,
  LoopMaxIterationsError,
  NodeMaxRetriesError,
  ValidationError,
} from "@ageflow/core";
```

## License

MIT
