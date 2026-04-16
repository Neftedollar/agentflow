import { defineAgent, defineWorkflow } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildJobTools } from "../job-tools.js";
import { buildToolDefinition } from "../tool-registry.js";

const agent = defineAgent({
  runner: "fake",
  input: z.object({ q: z.string() }),
  output: z.object({ a: z.string() }),
  prompt: () => "p",
});

const workflow = defineWorkflow({
  name: "ask",
  tasks: { t: { agent, input: { q: "hi" } } },
});

describe("buildJobTools", () => {
  it("returns exactly 5 tools with canonical names", () => {
    const tools = buildJobTools(workflow);
    expect(tools.map((t) => t.name)).toEqual([
      "start_ask",
      "get_workflow_status",
      "get_workflow_result",
      "resume_workflow",
      "cancel_workflow",
    ]);
  });

  it("start_<wf> input schema mirrors the sync tool's input schema", () => {
    const sync = buildToolDefinition(workflow);
    const [startTool] = buildJobTools(workflow);
    expect(startTool?.inputSchema).toEqual(sync.inputSchema);
  });

  it("start_<wf> output schema is { jobId: string }", () => {
    const [startTool] = buildJobTools(workflow);
    expect(startTool?.outputSchema).toMatchObject({
      type: "object",
      required: ["jobId"],
      properties: { jobId: { type: "string" } },
    });
  });

  it("observer tools share the { jobId } input schema", () => {
    const tools = buildJobTools(workflow);
    for (const name of [
      "get_workflow_status",
      "get_workflow_result",
      "cancel_workflow",
    ]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        required: ["jobId"],
        properties: { jobId: { type: "string" } },
      });
    }
  });

  it("resume_workflow input is { jobId, approved }", () => {
    const tools = buildJobTools(workflow);
    const resume = tools.find((t) => t.name === "resume_workflow");
    expect(resume?.inputSchema).toMatchObject({
      type: "object",
      required: ["jobId", "approved"],
      properties: {
        jobId: { type: "string" },
        approved: { type: "boolean" },
      },
    });
  });

  it("get_workflow_status output schema covers state + currentTask + progress", () => {
    const tools = buildJobTools(workflow);
    const status = tools.find((t) => t.name === "get_workflow_status");
    const props = (
      status?.outputSchema as { properties: Record<string, unknown> }
    ).properties;
    expect(props).toHaveProperty("state");
    expect(props).toHaveProperty("currentTask");
    expect(props).toHaveProperty("progress");
    expect(props).toHaveProperty("createdAt");
    expect(props).toHaveProperty("lastEventAt");
  });
});
