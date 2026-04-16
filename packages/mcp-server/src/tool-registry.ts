import type { WorkflowDef } from "@ageflow/core";
import { resolveMcpConfig } from "@ageflow/core";
import { findBoundaryTasks } from "./dag-boundary.js";
import { ErrorCode, McpServerError } from "./errors.js";
import { type McpJsonSchema, zodToMcpSchema } from "./schema-convert.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpJsonSchema;
  readonly outputSchema: McpJsonSchema;
  readonly inputTask: string;
  readonly outputTask: string;
}

/**
 * Build an MCP tool definition from a workflow:
 * - name = workflow.name
 * - description = workflow.mcp.description or fallback
 * - inputSchema = Zod → JSON Schema of the input task's `agent.input`
 * - outputSchema = Zod → JSON Schema of the output task's `agent.output`
 */
export function buildToolDefinition(workflow: WorkflowDef): ToolDefinition {
  let resolved: ReturnType<typeof resolveMcpConfig>;
  try {
    resolved = resolveMcpConfig(workflow.mcp);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith("WORKFLOW_NOT_MCP_EXPOSABLE:")
    ) {
      throw new McpServerError(
        ErrorCode.WORKFLOW_NOT_MCP_EXPOSABLE,
        err.message,
      );
    }
    throw err;
  }
  const boundary = findBoundaryTasks(
    workflow.tasks,
    resolved.inputTask,
    resolved.outputTask,
  );

  const inputTask = workflow.tasks[boundary.inputTask] as {
    agent: { input: import("zod").ZodType; output: import("zod").ZodType };
  };
  const outputTask = workflow.tasks[boundary.outputTask] as {
    agent: { input: import("zod").ZodType; output: import("zod").ZodType };
  };

  return {
    name: workflow.name,
    description:
      resolved.description ?? `Run ageflow workflow: ${workflow.name}`,
    inputSchema: zodToMcpSchema(inputTask.agent.input),
    outputSchema: zodToMcpSchema(outputTask.agent.output),
    inputTask: boundary.inputTask,
    outputTask: boundary.outputTask,
  };
}
