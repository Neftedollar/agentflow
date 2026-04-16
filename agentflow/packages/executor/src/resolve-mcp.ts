import type {
  AgentMcpConfig,
  McpServerConfig,
  TaskMcpOverride,
} from "@ageflow/core";

/**
 * Resolve the final list of MCP servers for a single task execution.
 *
 * Resolution rules (from spec §5.4):
 *
 * 1. Start with workflow-level servers (fallback).
 * 2. If `agentMcp` is present:
 *    - `extendWorkflow: true` → merge workflow + agent, agent wins on name conflict.
 *    - `extendWorkflow: false` (default) → agent list replaces workflow list entirely.
 * 3. If `taskOverride` is present, keep only servers whose name is in the whitelist.
 *    Unknown names throw — pre-flight should have caught these earlier.
 *
 * Deduplication: last-writer-wins by `name` when lists are merged.
 */
export function resolveMcp(
  workflowServers: readonly McpServerConfig[] | undefined,
  agentMcp: AgentMcpConfig | undefined,
  taskOverride: TaskMcpOverride | undefined,
): readonly McpServerConfig[] {
  let resolved: readonly McpServerConfig[];

  if (agentMcp === undefined) {
    // No agent-level config — use workflow servers as-is (may be empty).
    resolved = workflowServers ?? [];
  } else if (agentMcp.extendWorkflow === true) {
    // Merge: workflow first, then agent — agent wins on duplicate name.
    const merged = new Map<string, McpServerConfig>();
    for (const s of workflowServers ?? []) {
      merged.set(s.name, s);
    }
    for (const s of agentMcp.servers) {
      merged.set(s.name, s);
    }
    resolved = [...merged.values()];
  } else {
    // Replace: agent list fully replaces workflow list.
    resolved = agentMcp.servers;
  }

  // Apply task-level override (whitelist by name).
  if (taskOverride !== undefined) {
    const filtered: McpServerConfig[] = [];

    for (const name of taskOverride.servers) {
      const found = resolved.find((s) => s.name === name);
      if (found === undefined) {
        throw new Error(
          `Task mcpOverride references unknown server "${name}". Available servers: [${resolved.map((s) => s.name).join(", ")}]`,
        );
      }
      filtered.push(found);
    }

    return filtered;
  }

  return resolved;
}
