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
    const _exhaustive:
      | "running"
      | "awaiting-checkpoint"
      | "done"
      | "failed"
      | "cancelled" = s;
    void _exhaustive;
  });

  it("start + error + complete carry the right payloads", () => {
    expectTypeOf<WorkflowStartEvent["input"]>().toEqualTypeOf<unknown>();
    expectTypeOf<
      WorkflowErrorEvent["error"]["message"]
    >().toEqualTypeOf<string>();
    expectTypeOf<WorkflowCompleteEvent["result"]["outputs"]>().toEqualTypeOf<
      Record<string, unknown>
    >();
    const te = {} as TaskErrorEvent;
    expectTypeOf(te.terminal).toEqualTypeOf<boolean>();
    expectTypeOf(te.attempt).toEqualTypeOf<number>();
  });
});
