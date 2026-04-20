import type { WorkflowDef } from "@ageflow/core";
import { describe, expectTypeOf, it } from "vitest";
import { createRunner } from "../runner.js";
import type { RunHandle, RunStore, Runner, WorkflowResult } from "../types.js";

// Use a real but minimal tasks map to avoid the {} ban.
type EmptyTasks = Record<string, never>;

describe("types", () => {
  it("stream yields WorkflowEvent, returns WorkflowResult<T>", () => {
    const r: Runner = createRunner();
    type WF = WorkflowDef<EmptyTasks>;
    const gen = r.stream({} as WF);
    expectTypeOf(gen).toMatchTypeOf<
      AsyncGenerator<unknown, WorkflowResult<EmptyTasks>, void>
    >();
  });

  it("fire returns RunHandle synchronously", () => {
    const r: Runner = createRunner();
    type WF = WorkflowDef<EmptyTasks>;
    expectTypeOf(r.fire({} as WF)).toEqualTypeOf<RunHandle>();
  });

  it("run returns Promise<WorkflowResult<T>>", () => {
    const r: Runner = createRunner();
    type WF = WorkflowDef<EmptyTasks>;
    expectTypeOf(r.run({} as WF)).toMatchTypeOf<
      Promise<WorkflowResult<EmptyTasks>>
    >();
  });

  it("resume and cancel take correct parameter types", () => {
    const r: Runner = createRunner();
    expectTypeOf(r.resume).toMatchTypeOf<
      (runId: string, approved: boolean) => void
    >();
    expectTypeOf(r.cancel).toMatchTypeOf<(runId: string) => void>();
  });

  it("get returns RunHandle | undefined, list returns readonly RunHandle[]", () => {
    const r: Runner = createRunner();
    expectTypeOf(r.get("id")).toEqualTypeOf<RunHandle | undefined>();
    expectTypeOf(r.list()).toMatchTypeOf<readonly RunHandle[]>();
  });

  it("createRunner accepts a RunStore", () => {
    const store: RunStore = {
      get: () => undefined,
      list: () => [],
      upsert: () => {},
      delete: () => {},
      close: () => {},
    };
    expectTypeOf(createRunner({ store })).toMatchTypeOf<Runner>();
  });
});
