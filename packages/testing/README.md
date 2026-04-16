# @ageflow/testing

[![npm](https://img.shields.io/npm/v/@ageflow/testing)](https://www.npmjs.com/package/@ageflow/testing)

Test harness for [ageflow](../../README.md) workflows. Mock agents return predetermined responses — no CLI installed, no API calls, tests run in milliseconds.

## Install

```bash
bun add -D @ageflow/testing
```

## Quick example

```ts
import { createTestHarness } from "@ageflow/testing";
import { describe, expect, it } from "vitest";
import myWorkflow from "./workflow.js";

describe("my workflow", () => {
  it("runs end-to-end with mocked agents", async () => {
    const harness = createTestHarness(myWorkflow);

    harness.mockAgent("analyze", {
      issues: [{ id: "1", file: "src/app.ts", description: "unused var" }],
    });
    harness.mockAgent("fix", { patch: "- const x\n+ const _x" });

    const result = await harness.run();

    expect(result.outputs["fix"]).toEqual({ patch: "- const x\n+ const _x" });
  });
});
```

## API

### `createTestHarness(workflow)`

Returns a `TestHarness` for the given workflow definition.

```ts
const harness = createTestHarness(workflow);
```

### `harness.mockAgent(taskName, response)`

Register a mock response for a task. Three forms:

```ts
// Always return the same response
harness.mockAgent("classify", { label: "positive", confidence: 0.97 });

// Return different responses on successive calls
harness.mockAgent("fix", [
  { patch: "attempt 1" },  // call 1
  { patch: "attempt 2" },  // call 2 — last element repeats if exhausted
]);

// Simulate a failure (triggers retry logic)
harness.mockAgent("validate", { throws: new Error("syntax error") });
```

### `harness.run(input?)`

Run the workflow with all mocked runners. Returns `WorkflowResult`.

```ts
const result = await harness.run();
// result.outputs["taskName"] — typed output of each task
```

Pass an input if your workflow expects one:

```ts
const result = await harness.run({ repo: "my-org/my-repo" });
```

### `harness.getTask(name)`

Inspect call statistics after `run()`:

```ts
const stats = harness.getTask("fix");
// stats.callCount  — total spawn calls (includes retried attempts)
// stats.retryCount — how many times the task was retried
// stats.outputs    — all successful outputs, in call order
```

## Testing loops

Loops call inner tasks repeatedly. Use an array mock to return different responses per iteration:

```ts
harness.mockAgent("eval", [
  { satisfied: false },  // iteration 1 — keep looping
  { satisfied: false },  // iteration 2
  { satisfied: true },   // iteration 3 — loop exits
]);
```

## Testing HITL workflows

The harness bypasses HITL checkpoints by default (auto-approves). To override:

```ts
const harness = createTestHarness({
  ...myWorkflow,
  hooks: {
    onCheckpoint: async (taskName) => {
      // return false to simulate rejection
      return taskName !== "deploy";
    },
  },
});
```

## License

MIT
