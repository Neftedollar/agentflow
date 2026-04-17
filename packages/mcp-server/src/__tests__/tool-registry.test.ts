import type { WorkflowDef } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCode, McpServerError } from "../errors.js";
import { buildToolDefinition } from "../tool-registry.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper accepts arbitrary mcp config shapes
const mkWorkflow = (mcp?: any): WorkflowDef =>
  ({
    name: "test-flow",
    mcp,
    tasks: {
      start: {
        agent: {
          runner: "claude",
          model: "claude-sonnet-4-6",
          input: z.object({ x: z.string() }),
          output: z.object({ y: z.number() }),
          prompt: () => "",
        },
        // biome-ignore lint/suspicious/noExplicitAny: casting partial task config for test fixture
      } as any,
    },
    // biome-ignore lint/suspicious/noExplicitAny: casting partial workflow config for test fixture
  }) as any;

describe("buildToolDefinition", () => {
  it("derives tool name from workflow.name", () => {
    const tool = buildToolDefinition(mkWorkflow());
    expect(tool.name).toBe("test-flow");
  });

  it("uses description from mcp.description", () => {
    const tool = buildToolDefinition(mkWorkflow({ description: "my tool" }));
    expect(tool.description).toBe("my tool");
  });

  it("falls back to default description", () => {
    const tool = buildToolDefinition(mkWorkflow());
    expect(tool.description).toMatch(/Run ageflow workflow: test-flow/);
  });

  it("inputSchema derived from input task", () => {
    const tool = buildToolDefinition(mkWorkflow());
    expect(tool.inputSchema.properties).toHaveProperty("x");
  });

  it("outputSchema derived from output task", () => {
    const tool = buildToolDefinition(mkWorkflow());
    expect(tool.outputSchema.properties).toHaveProperty("y");
  });

  it("throws when workflow.mcp === false", () => {
    let caught: unknown;
    try {
      buildToolDefinition(mkWorkflow(false));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpServerError);
    expect((caught as McpServerError).errorCode).toBe(
      ErrorCode.WORKFLOW_NOT_MCP_EXPOSABLE,
    );
  });
});
