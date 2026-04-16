/**
 * mcp-tool-adapter.ts
 *
 * Walks each McpClient, calls listTools(), filters by allowlist (pre-dispatch),
 * and wraps each remaining tool in a ToolDefinition for use in the ToolRegistry.
 *
 * Defence-in-depth:
 *   1. Pre-dispatch: filterMcpTools() strips tools outside the allowlist before
 *      they reach the model. Filtered tools never appear in the registry.
 *   2. Post-dispatch: execute() re-checks isMcpToolPermitted() — should never
 *      fire in normal operation but guards against unexpected code paths.
 *   3. Refine: if server.refine[toolName] is set, args are parsed through the
 *      Zod schema before forwarding to the server.
 */

import {
  AgentFlowError,
  filterMcpTools,
  isMcpToolPermitted,
  mcpToolFqn,
} from "@ageflow/core";
import type { McpClient } from "./mcp-client.js";
import type { ToolDefinition, ToolRegistry } from "./types.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class McpToolNotPermittedError extends AgentFlowError {
  readonly code = "mcp_tool_not_permitted" as const;
  constructor(
    readonly toolName: string,
    readonly serverName: string,
  ) {
    super(
      `mcp_tool_not_permitted: tool "${toolName}" is not in the allowlist for server "${serverName}"`,
    );
  }
}

export class McpToolArgInvalidError extends AgentFlowError {
  readonly code = "mcp_tool_arg_invalid" as const;
  constructor(
    readonly toolName: string,
    cause?: unknown,
  ) {
    const msg =
      cause instanceof Error ? cause.message : String(cause ?? "invalid args");
    super(`mcp_tool_arg_invalid: ${toolName}: ${msg}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * For each McpClient, list its tools, apply allowlist filtering, and return
 * a ToolRegistry keyed by `mcp__<serverName>__<toolName>`.
 */
export async function mcpToolsToRegistry(
  clients: readonly McpClient[],
): Promise<ToolRegistry> {
  const registry: ToolRegistry = {};

  for (const client of clients) {
    const allTools = await client.listTools();
    // Pre-dispatch: filter by allowlist
    const permitted = filterMcpTools(client.config, allTools);

    for (const tool of permitted) {
      const fqn = mcpToolFqn(client.config.name, tool.name);
      const toolDef = buildToolDefinition(client, tool.name, tool);
      registry[fqn] = toolDef;
    }
  }

  return registry;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildToolDefinition(
  client: McpClient,
  toolName: string,
  descriptor: {
    name: string;
    description?: string | undefined;
    inputSchema?: unknown;
  },
): ToolDefinition {
  return {
    description: descriptor.description ?? "",
    parameters:
      descriptor.inputSchema !== null &&
      typeof descriptor.inputSchema === "object"
        ? (descriptor.inputSchema as Record<string, unknown>)
        : { type: "object" },

    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      const { config } = client;

      // Post-dispatch re-check (defence in depth)
      if (!isMcpToolPermitted(config, toolName)) {
        throw new McpToolNotPermittedError(toolName, config.name);
      }

      // Refine validation
      const refineSchema = config.refine?.[toolName];
      if (refineSchema !== undefined) {
        const result = refineSchema.safeParse(args);
        if (!result.success) {
          throw new McpToolArgInvalidError(toolName, result.error);
        }
      }

      return client.callTool(toolName, args);
    },
  };
}
