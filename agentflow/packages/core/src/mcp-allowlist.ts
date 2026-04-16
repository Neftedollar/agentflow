import type { McpServerConfig } from "./types.js";

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** Pre-dispatch: strip tools the model should never see. */
export function filterMcpTools<T extends { name: string }>(
  server: McpServerConfig,
  tools: readonly T[],
): readonly T[] {
  if (!server.tools) return tools;
  const allow = new Set(server.tools);
  return tools.filter((t) => allow.has(t.name));
}

/** Post-dispatch: reject tool calls the model should not have been able to make. */
export function isMcpToolPermitted(
  server: McpServerConfig,
  toolName: string,
): boolean {
  if (!server.tools) return true;
  return server.tools.includes(toolName);
}

/** Canonical name exposed to the model — matches Claude CLI convention. */
export function mcpToolFqn(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** Parse back an FQN into (server, tool). Returns undefined for non-MCP names. */
export function parseMcpToolFqn(
  fqn: string,
): { server: string; tool: string } | undefined {
  const m = fqn.match(/^mcp__([^_]+)__(.+)$/);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  return { server: m[1], tool: m[2] };
}
