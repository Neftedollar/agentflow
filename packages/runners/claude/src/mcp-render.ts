import type { McpServerConfig } from "@ageflow/core";

// ─── Claude CLI MCP config shape ──────────────────────────────────────────────

interface ClaudeMcpServerEntry {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

interface ClaudeMcpConfig {
  mcpServers: Record<string, ClaudeMcpServerEntry>;
}

/**
 * Render an array of McpServerConfig into the JSON shape expected by
 * Claude CLI's `--mcp-config` flag.
 *
 * Notes:
 * - `tools` allowlist is NOT included here — it is passed as `--allowedTools`
 *   CLI flags in the spawner, using the `mcp__<server>__<tool>` FQN format.
 * - `env` is omitted entirely when the server config has no env entries.
 * - `args` is omitted when empty/undefined.
 */
export function renderMcpJson(
  servers: readonly McpServerConfig[],
): ClaudeMcpConfig {
  const mcpServers: Record<string, ClaudeMcpServerEntry> = {};

  for (const srv of servers) {
    const entry: ClaudeMcpServerEntry = { command: srv.command };

    if (srv.args !== undefined && srv.args.length > 0) {
      entry.args = srv.args;
    }

    if (srv.env !== undefined && Object.keys(srv.env).length > 0) {
      entry.env = srv.env;
    }

    mcpServers[srv.name] = entry;
  }

  return { mcpServers };
}
