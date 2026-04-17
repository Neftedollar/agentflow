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
