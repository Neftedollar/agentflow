import { BudgetExceededError } from "@ageflow/core";
import { HitlNotInteractiveError } from "@ageflow/executor";
import {
  CheckpointTimeoutError,
  InvalidRunStateError,
  RunNotFoundError,
} from "@ageflow/server";

export const ErrorCode = {
  INPUT_VALIDATION_FAILED: "INPUT_VALIDATION_FAILED",
  OUTPUT_VALIDATION_FAILED: "OUTPUT_VALIDATION_FAILED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  DURATION_EXCEEDED: "DURATION_EXCEEDED",
  TURNS_EXCEEDED: "TURNS_EXCEEDED",
  WORKFLOW_FAILED: "WORKFLOW_FAILED",
  HITL_ELICITATION_UNSUPPORTED: "HITL_ELICITATION_UNSUPPORTED",
  HITL_DENIED: "HITL_DENIED",
  HITL_CANCELLED: "HITL_CANCELLED",
  WORKFLOW_NOT_MCP_EXPOSABLE: "WORKFLOW_NOT_MCP_EXPOSABLE",
  RUNNER_PREFLIGHT_FAILED: "RUNNER_PREFLIGHT_FAILED",
  BUSY: "BUSY",
  SERVER_SHUTDOWN: "SERVER_SHUTDOWN",
  DAG_INVALID: "DAG_INVALID",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  JOB_CANCELLED: "JOB_CANCELLED",
  INVALID_RUN_STATE: "INVALID_RUN_STATE",
  ASYNC_MODE_DISABLED: "ASYNC_MODE_DISABLED",
  RESERVED_TOOL_NAME: "RESERVED_TOOL_NAME",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class McpServerError extends Error {
  constructor(
    public readonly errorCode: ErrorCodeValue,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpServerError";
  }
}

export interface McpToolErrorResult {
  readonly content: readonly { type: "text"; text: string }[];
  readonly structuredContent: {
    readonly errorCode: ErrorCodeValue;
    readonly message: string;
    readonly context?: Record<string, unknown>;
  };
  readonly isError: true;
}

export function formatErrorResult(err: unknown): McpToolErrorResult {
  if (err instanceof McpServerError) {
    return {
      content: [{ type: "text", text: err.message }],
      structuredContent: {
        errorCode: err.errorCode,
        message: err.message,
        ...(err.context !== undefined ? { context: err.context } : {}),
      },
      isError: true,
    };
  }

  if (err instanceof BudgetExceededError) {
    return {
      content: [{ type: "text", text: err.message }],
      structuredContent: {
        errorCode: ErrorCode.BUDGET_EXCEEDED,
        message: err.message,
        context: { maxCost: err.maxCost, spent: err.actualCost },
      },
      isError: true,
    };
  }

  if (err instanceof HitlNotInteractiveError) {
    return {
      content: [{ type: "text", text: err.message }],
      structuredContent: {
        errorCode: ErrorCode.HITL_DENIED,
        message: err.message,
        context: { taskName: err.taskName },
      },
      isError: true,
    };
  }

  if (err instanceof RunNotFoundError) {
    return {
      content: [{ type: "text", text: err.message }],
      structuredContent: {
        errorCode: ErrorCode.JOB_NOT_FOUND,
        message: err.message,
        context: { runId: err.runId },
      },
      isError: true,
    };
  }

  if (err instanceof InvalidRunStateError) {
    return {
      content: [{ type: "text", text: err.message }],
      structuredContent: {
        errorCode: ErrorCode.INVALID_RUN_STATE,
        message: err.message,
        context: { runId: err.runId, state: err.state },
      },
      isError: true,
    };
  }

  if (err instanceof CheckpointTimeoutError) {
    return {
      content: [{ type: "text", text: err.message }],
      structuredContent: {
        errorCode: ErrorCode.HITL_CANCELLED,
        message: err.message,
        context: { taskName: err.taskName },
      },
      isError: true,
    };
  }

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err);

  return {
    content: [{ type: "text", text: message }],
    structuredContent: {
      errorCode: ErrorCode.WORKFLOW_FAILED,
      message,
    },
    isError: true,
  };
}
