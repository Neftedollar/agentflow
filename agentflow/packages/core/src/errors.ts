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
