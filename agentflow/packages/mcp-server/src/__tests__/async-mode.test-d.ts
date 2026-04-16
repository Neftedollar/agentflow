import type { WorkflowDef } from "@ageflow/core";
import { describe, expectTypeOf, it } from "vitest";
import { buildJobTools } from "../job-tools.js";
import { buildToolDefinition } from "../tool-registry.js";

declare const wf: WorkflowDef;

describe("async-mode type guards", () => {
  it("start_<wf> inputSchema type matches sync tool's inputSchema type", () => {
    const sync = buildToolDefinition(wf);
    const [start] = buildJobTools(wf);
    expectTypeOf(start?.inputSchema).toEqualTypeOf<typeof sync.inputSchema>();
  });
});
