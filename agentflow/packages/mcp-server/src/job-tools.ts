import type { WorkflowDef } from "@ageflow/core";
import type { McpJsonSchema } from "./schema-convert.js";
import { type ToolDefinition, buildToolDefinition } from "./tool-registry.js";

const JOB_ID_SCHEMA: McpJsonSchema = {
  type: "object",
  required: ["jobId"],
  properties: {
    jobId: { type: "string", description: "Job identifier (UUID)" },
  },
  additionalProperties: false,
};

const RESUME_SCHEMA: McpJsonSchema = {
  type: "object",
  required: ["jobId", "approved"],
  properties: {
    jobId: { type: "string", description: "Job identifier (UUID)" },
    approved: {
      type: "boolean",
      description: "true to approve checkpoint, false to reject",
    },
  },
  additionalProperties: false,
};

const STATUS_OUTPUT_SCHEMA: McpJsonSchema = {
  type: "object",
  required: ["state", "createdAt", "lastEventAt"],
  properties: {
    state: {
      type: "string",
      enum: ["running", "awaiting-checkpoint", "done", "failed", "cancelled"],
    },
    currentTask: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["task", "checkpoint"] },
        message: { type: "string" },
      },
    },
    progress: {
      type: "object",
      properties: {
        tasksCompleted: { type: "number" },
        tasksTotal: { type: "number" },
        spentUsd: { type: "number" },
        limitUsd: { type: "number" },
      },
    },
    createdAt: { type: "number" },
    lastEventAt: { type: "number" },
  },
};

const RESULT_OUTPUT_SCHEMA: McpJsonSchema = {
  type: "object",
  // Either { pending: true } OR { state: "done", output: ..., metrics: ... }
  properties: {
    pending: { type: "boolean" },
    state: { type: "string" },
    output: {},
    metrics: { type: "object" },
  },
};

const CANCEL_OUTPUT_SCHEMA: McpJsonSchema = {
  type: "object",
  required: ["cancelled", "priorState"],
  properties: {
    cancelled: { type: "boolean" },
    priorState: { type: "string" },
  },
  additionalProperties: false,
};

const RESUME_OUTPUT_SCHEMA: McpJsonSchema = {
  type: "object",
  required: ["resumed"],
  properties: { resumed: { type: "boolean" } },
  additionalProperties: false,
};

/**
 * Build the 5 MCP tool definitions exposed in async mode:
 *
 *   start_<workflow.name>   — fire-and-forget; returns { jobId }
 *   get_workflow_status     — poll state + progress
 *   get_workflow_result     — fetch validated output (or { pending: true })
 *   resume_workflow         — approve/reject a checkpoint
 *   cancel_workflow         — best-effort cancel
 *
 * Named after the workflow so clients get per-workflow input typing
 * (spec §Open questions #1). Observer tools are generic because any
 * call references a runId that a `start_*` produced.
 */
export function buildJobTools(
  workflow: WorkflowDef,
): readonly ToolDefinition[] {
  const sync = buildToolDefinition(workflow);
  const wf = workflow.name;
  return [
    {
      name: `start_${wf}`,
      description: `Start workflow "${wf}" asynchronously. Returns a jobId for polling.`,
      inputSchema: sync.inputSchema,
      outputSchema: {
        type: "object",
        required: ["jobId"],
        properties: {
          jobId: { type: "string", description: "UUID for polling" },
        },
        additionalProperties: false,
      },
      inputTask: sync.inputTask,
      outputTask: sync.outputTask,
    },
    {
      name: "get_workflow_status",
      description: "Poll the current state of an async workflow job.",
      inputSchema: JOB_ID_SCHEMA,
      outputSchema: STATUS_OUTPUT_SCHEMA,
      inputTask: sync.inputTask,
      outputTask: sync.outputTask,
    },
    {
      name: "get_workflow_result",
      description:
        "Fetch the validated output of a completed async workflow job. Returns { pending: true } while still running.",
      inputSchema: JOB_ID_SCHEMA,
      outputSchema: RESULT_OUTPUT_SCHEMA,
      inputTask: sync.inputTask,
      outputTask: sync.outputTask,
    },
    {
      name: "resume_workflow",
      description:
        "Resolve an awaiting-checkpoint job. Pass approved=true to continue, false to reject.",
      inputSchema: RESUME_SCHEMA,
      outputSchema: RESUME_OUTPUT_SCHEMA,
      inputTask: sync.inputTask,
      outputTask: sync.outputTask,
    },
    {
      name: "cancel_workflow",
      description:
        "Cancel an async workflow job. Idempotent: returns cancelled=false if the job is already terminal.",
      inputSchema: JOB_ID_SCHEMA,
      outputSchema: CANCEL_OUTPUT_SCHEMA,
      inputTask: sync.inputTask,
      outputTask: sync.outputTask,
    },
  ];
}
