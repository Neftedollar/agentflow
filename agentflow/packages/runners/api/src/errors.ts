import { AgentFlowError } from "@ageflow/core";

export class McpPoolCollisionError extends AgentFlowError {
  readonly code = "mcp_pool_collision" as const;
  constructor(
    readonly serverName: string,
    options?: ErrorOptions,
  ) {
    super(
      `MCP server pool collision: '${serverName}' already started with different command/args/env. Use a unique server name or ensure spawn args match.`,
      options,
    );
  }
}

export class MaxToolRoundsError extends AgentFlowError {
  readonly code = "tool_loop_exceeded" as const;
  constructor(
    readonly rounds: number,
    options?: ErrorOptions,
  ) {
    super(`Tool loop exceeded max rounds: ${rounds}`, options);
  }
}

export class ApiRequestError extends AgentFlowError {
  readonly code = "api_request_failed" as const;
  constructor(
    readonly status: number,
    readonly body: string,
    options?: ErrorOptions,
  ) {
    super(`API request failed (${status}): ${body}`, options);
  }
}

export class ToolNotFoundError extends AgentFlowError {
  readonly code = "tool_not_found" as const;
  constructor(
    readonly toolName: string,
    options?: ErrorOptions,
  ) {
    super(`Tool not registered: ${toolName}`, options);
  }
}
