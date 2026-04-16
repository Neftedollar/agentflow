import type { McpServerConfig } from "@ageflow/core";

/**
 * Escape a string value for use inside a TOML inline string (double-quoted).
 * Escapes backslashes first, then double-quotes.
 */
function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Render a string array as a TOML/JSON-compatible array literal.
 * Each element is a double-quoted TOML string with proper escaping.
 * Example: ["a", "b"] → '["a","b"]'
 */
function renderStringArray(values: readonly string[]): string {
  return `[${values.map((v) => `"${tomlEscape(v)}"`).join(",")}]`;
}

/**
 * Render an env map as a JSON object string.
 * Codex's `-c` flag parses values as JSON when possible; `mcp_servers.<id>.env`
 * expects a map<string,string>, so we must emit a valid JSON object.
 * Example: { FOO: "bar" } → '{"FOO":"bar"}'
 */
function renderEnvTable(env: Readonly<Record<string, string>>): string {
  return JSON.stringify(env);
}

/**
 * Render an array of McpServerConfig into Codex CLI `-c` override flags.
 *
 * Each server produces one or more `-c mcp_servers.<name>.<field>=<value>` pairs.
 * The `tools` allowlist IS included here (unlike the Claude runner) because
 * Codex `-c` overrides are the only mechanism for tool filtering.
 *
 * Output interleaves `-c` with the key=value string so the caller can spread
 * directly into the `codex exec` args array.
 */
export function renderCodexMcpFlags(
  servers: readonly McpServerConfig[],
): string[] {
  const flags: string[] = [];

  for (const srv of servers) {
    const prefix = `mcp_servers.${srv.name}`;

    // command — always present
    flags.push("-c", `${prefix}.command=${srv.command}`);

    // args — only when non-empty
    if (srv.args !== undefined && srv.args.length > 0) {
      flags.push("-c", `${prefix}.args=${renderStringArray(srv.args)}`);
    }

    // env — only when non-empty
    if (srv.env !== undefined && Object.keys(srv.env).length > 0) {
      flags.push("-c", `${prefix}.env=${renderEnvTable(srv.env)}`);
    }

    // tools allowlist — only when set (Codex uses `enabled_tools`)
    if (srv.tools !== undefined && srv.tools.length > 0) {
      flags.push(
        "-c",
        `${prefix}.enabled_tools=${renderStringArray(srv.tools)}`,
      );
    }

    // cwd override — only when set
    if (srv.cwd !== undefined) {
      flags.push("-c", `${prefix}.cwd=${srv.cwd}`);
    }
  }

  return flags;
}
