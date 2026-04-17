import type { RetryErrorKind } from "./types.js";

/** Base error for all AgentFlow errors. */
export abstract class AgentFlowError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    // Fix prototype chain for transpiled ES5/CommonJS targets
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      cause:
        this.cause instanceof Error
          ? ((this.cause as AgentFlowError).toJSON?.() ?? this.cause.message)
          : this.cause,
    };
  }

  static fromJSON(json: Record<string, unknown>): AgentFlowError {
    // Registry-based revival — extend in each subclass if needed
    const msg =
      typeof json.message === "string" ? json.message : "Unknown error";
    const err = new GenericAgentFlowError(
      msg,
      typeof json.code === "string" ? json.code : "unknown",
    );
    return err;
  }
}

/** Fallback for deserialized errors without a specific class. */
export class GenericAgentFlowError extends AgentFlowError {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface AttemptRecord {
  readonly attempt: number;
  readonly error: string;
  readonly errorCode: RetryErrorKind;
}

export class NodeMaxRetriesError extends AgentFlowError {
  readonly code = "node_max_retries" as const;
  constructor(
    readonly taskName: string,
    readonly attempts: readonly AttemptRecord[],
    options?: ErrorOptions,
  ) {
    super(
      `Task "${taskName}" failed after ${attempts.length} attempt(s). Last error: ${attempts.at(-1)?.error ?? "unknown"}`,
      options,
    );
  }
  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      taskName: this.taskName,
      attempts: this.attempts,
    };
  }
}

export class LoopMaxIterationsError extends AgentFlowError {
  readonly code = "loop_max_iterations" as const;
  constructor(
    readonly taskName: string,
    readonly maxIterations: number,
    options?: ErrorOptions,
  ) {
    super(
      `Loop "${taskName}" exceeded max iterations (${maxIterations})`,
      options,
    );
  }
}

export class ToolNotUsedError extends AgentFlowError {
  readonly code = "tool_not_used" as const;
  constructor(
    readonly taskName: string,
    readonly requiredTools: readonly string[],
    options?: ErrorOptions,
  ) {
    super(
      `Task "${taskName}" did not use required tools: ${requiredTools.join(", ")}`,
      options,
    );
  }
}

export class BudgetExceededError extends AgentFlowError {
  readonly code = "budget_exceeded" as const;
  constructor(
    readonly maxCost: number,
    readonly actualCost: number,
    options?: ErrorOptions,
  ) {
    super(
      `Budget exceeded: spent $${actualCost.toFixed(4)} (limit $${maxCost.toFixed(4)})`,
      options,
    );
  }
}

export class ValidationError extends AgentFlowError {
  readonly code = "validation_error" as const;
  constructor(
    readonly taskName: string,
    readonly zodError: string,
    options?: ErrorOptions,
  ) {
    super(
      `Output validation failed for task "${taskName}": ${zodError}`,
      options,
    );
  }
}

export class AgentHitlConflictError extends AgentFlowError {
  readonly code = "agent_hitl_conflict" as const;
  constructor(
    readonly taskName: string,
    options?: ErrorOptions,
  ) {
    super(
      `Task "${taskName}" agent raised internal HITL prompt — use allowedTools or dangerously-skip-permissions`,
      options,
    );
  }
}

export class PreFlightError extends AgentFlowError {
  readonly code = "pre_flight_error" as const;
  constructor(
    readonly errors: readonly string[],
    readonly warnings: readonly string[],
    options?: ErrorOptions,
  ) {
    super(
      `Pre-flight validation failed:\n${errors.map((e) => `  ✗ ${e}`).join("\n")}`,
      options,
    );
  }
}

export class InvalidIdentifierError extends AgentFlowError {
  readonly code = "invalid_identifier" as const;
  constructor(
    readonly field: string,
    readonly value: string,
    options?: ErrorOptions,
  ) {
    super(
      `${field} "${value}" contains invalid characters. Must match /^[a-zA-Z0-9._-]+$/`,
      options,
    );
  }
}

export class PathTraversalError extends AgentFlowError {
  readonly code = "path_traversal" as const;
  constructor(
    readonly path: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Path traversal rejected: "${path}" — ${reason}`, options);
  }
}

export class SessionMismatchError extends AgentFlowError {
  readonly code = "session_mismatch" as const;
  constructor(
    readonly taskName: string,
    readonly expectedRunner: string,
    readonly actualRunner: string,
    options?: ErrorOptions,
  ) {
    super(
      `Session mismatch on task "${taskName}": expected runner "${expectedRunner}", got "${actualRunner}". Cross-provider session sharing is not supported.`,
      options,
    );
  }
}

export class TimeoutError extends AgentFlowError {
  readonly code = "timeout" as const;
  constructor(
    readonly taskName: string,
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`Task "${taskName}" timed out after ${timeoutMs}ms`, options);
  }
}

// ─── Inline tools error ───────────────────────────────────────────────────────

/**
 * Thrown by subprocess runners (runner-claude, runner-codex) when an AgentDef
 * carries inline tool definitions (`tools: Record<string, InlineToolDef>`).
 *
 * Inline tools require in-process execution; subprocess runners cannot invoke
 * them.  Migrate to the runner's own tool-config mechanism or switch to
 * runner-api / runner-anthropic.
 */
export class InlineToolsNotSupportedError extends AgentFlowError {
  readonly code = "inline_tools_not_supported" as const;
  constructor(
    readonly runnerName: string,
    options?: ErrorOptions,
  ) {
    super(
      `Runner "${runnerName}" does not support inline tool definitions (AgentDef.tools as a map). Use a string[] allowlist with the runner's constructor tools config, or switch to runner-api / runner-anthropic.`,
      options,
    );
  }
}

// ─── MCP error hierarchy ──────────────────────────────────────────────────────

/**
 * MCP server process failed to start (ENOENT, non-zero exit, etc.).
 * Retriable — maps to the "mcp_server_start_failed" error kind.
 */
export class McpServerStartFailedError extends AgentFlowError {
  readonly code = "mcp_server_start_failed" as const;
  constructor(
    readonly serverName: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`MCP server "${serverName}" failed to start: ${reason}`, options);
  }
}

/**
 * MCP server process crashed after successful startup.
 */
export class McpServerCrashedError extends AgentFlowError {
  readonly code = "mcp_server_crashed" as const;
  constructor(
    readonly serverName: string,
    readonly exitCode: number | null,
    options?: ErrorOptions,
  ) {
    super(
      `MCP server "${serverName}" crashed (exit code: ${exitCode ?? "unknown"})`,
      options,
    );
  }
}

/**
 * Model called an MCP tool that does not exist on the server.
 */
export class McpToolNotFoundError extends AgentFlowError {
  readonly code = "mcp_tool_not_found" as const;
  constructor(
    readonly serverName: string,
    readonly toolName: string,
    options?: ErrorOptions,
  ) {
    super(`MCP tool "${serverName}/${toolName}" not found on server`, options);
  }
}

/**
 * Model attempted to call a tool not in the allowlist. Double-enforcement
 * guard — this fires post-dispatch if the model somehow bypassed the
 * pre-dispatch filter.
 */
export class McpToolNotPermittedError extends AgentFlowError {
  readonly code = "mcp_tool_not_permitted" as const;
  constructor(
    readonly serverName: string,
    readonly toolName: string,
    options?: ErrorOptions,
  ) {
    super(
      `MCP tool call not permitted: "${serverName}/${toolName}" is not in the allowlist`,
      options,
    );
  }
}

/**
 * Tool arguments failed the per-tool Zod refinement (e.g. `safePath()`).
 */
export class McpToolArgInvalidError extends AgentFlowError {
  readonly code = "mcp_tool_arg_invalid" as const;
  constructor(
    readonly serverName: string,
    readonly toolName: string,
    readonly zodError: string,
    options?: ErrorOptions,
  ) {
    super(
      `MCP tool "${serverName}/${toolName}" argument validation failed: ${zodError}`,
      options,
    );
  }
}

/**
 * The MCP tool call returned an error result from the server.
 */
export class McpToolCallFailedError extends AgentFlowError {
  readonly code = "mcp_tool_call_failed" as const;
  constructor(
    readonly serverName: string,
    readonly toolName: string,
    readonly serverError: string,
    options?: ErrorOptions,
  ) {
    super(
      `MCP tool "${serverName}/${toolName}" call failed: ${serverError}`,
      options,
    );
  }
}

/**
 * Low-level MCP protocol error (malformed message, unexpected sequence, etc.).
 */
export class McpProtocolError extends AgentFlowError {
  readonly code = "mcp_protocol_error" as const;
  constructor(
    readonly serverName: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`MCP protocol error with server "${serverName}": ${detail}`, options);
  }
}

/**
 * MCP tool call exceeded its per-call timeout (`mcpCallTimeoutMs`).
 */
export class McpTimeoutError extends AgentFlowError {
  readonly code = "mcp_timeout" as const;
  constructor(
    readonly serverName: string,
    readonly toolName: string,
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(
      `MCP tool "${serverName}/${toolName}" timed out after ${timeoutMs}ms`,
      options,
    );
  }
}
