import { describe, expect, it } from "vitest";
import { renderCodexMcpFlags } from "../mcp-render.js";

describe("renderCodexMcpFlags", () => {
  it("returns [] for empty input", () => {
    expect(renderCodexMcpFlags([])).toEqual([]);
  });

  it("emits one -c pair per field", () => {
    const flags = renderCodexMcpFlags([
      {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { FOO: "bar" },
        tools: ["read_file"],
      },
    ]);
    expect(flags).toContain("-c");
    expect(flags).toContain("mcp_servers.filesystem.command=npx");
    expect(flags).toContain(
      'mcp_servers.filesystem.args=["-y","@modelcontextprotocol/server-filesystem","/tmp"]',
    );
    // Bug 2 fix: env must be a JSON object, not TOML inline table
    expect(flags).toContain('mcp_servers.filesystem.env={"FOO":"bar"}');
    // Bug 1 fix: allowlist key is `enabled_tools`, not `tools`
    expect(flags).toContain(
      'mcp_servers.filesystem.enabled_tools=["read_file"]',
    );
  });

  it("emits enabled_tools (not tools) for the allowlist", () => {
    const flags = renderCodexMcpFlags([
      { name: "srv", command: "cmd", tools: ["tool_a", "tool_b"] },
    ]);
    expect(flags).toContain(
      'mcp_servers.srv.enabled_tools=["tool_a","tool_b"]',
    );
    const hasOldKey = flags.some((f) => f.includes("mcp_servers.srv.tools="));
    expect(hasOldKey).toBe(false);
  });

  it("emits env as a valid JSON object", () => {
    const flags = renderCodexMcpFlags([
      { name: "srv", command: "cmd", env: { KEY: "value", ANOTHER: "one" } },
    ]);
    const envFlag = flags.find((f) => f.startsWith("mcp_servers.srv.env="));
    expect(envFlag).toBeDefined();
    const jsonStr = (envFlag ?? "").slice("mcp_servers.srv.env=".length);
    // Must parse as valid JSON
    const parsed = JSON.parse(jsonStr);
    expect(parsed).toEqual({ KEY: "value", ANOTHER: "one" });
  });

  it("emits cwd when configured", () => {
    const flags = renderCodexMcpFlags([
      { name: "srv", command: "cmd", cwd: "/workspace/project" },
    ]);
    expect(flags).toContain("mcp_servers.srv.cwd=/workspace/project");
  });

  it("does not emit cwd when not configured", () => {
    const flags = renderCodexMcpFlags([{ name: "srv", command: "cmd" }]);
    const hasCwd = flags.some((f) => f.includes("mcp_servers.srv.cwd"));
    expect(hasCwd).toBe(false);
  });

  it("escapes quotes/backslashes inside args (TOML-safe)", () => {
    const flags = renderCodexMcpFlags([
      { name: "x", command: "y", args: ['she said "hi"'] },
    ]);
    expect(flags.join(" ")).toMatch(/she said \\"hi\\"/);
  });

  it("omits args/env/tools entries when not set", () => {
    const flags = renderCodexMcpFlags([{ name: "x", command: "y" }]);
    expect(flags).toContain("mcp_servers.x.command=y");
    const hasArgs = flags.some((f) => f.includes("mcp_servers.x.args"));
    const hasEnv = flags.some((f) => f.includes("mcp_servers.x.env"));
    const hasTools = flags.some((f) => f.includes("mcp_servers.x.tools"));
    const hasEnabledTools = flags.some((f) =>
      f.includes("mcp_servers.x.enabled_tools"),
    );
    expect(hasArgs).toBe(false);
    expect(hasEnv).toBe(false);
    expect(hasTools).toBe(false);
    expect(hasEnabledTools).toBe(false);
  });

  it("emits cwd + enabled_tools + JSON env together in a single server block", () => {
    const flags = renderCodexMcpFlags([
      {
        name: "full",
        command: "binary",
        args: ["--flag"],
        env: { TOKEN: "secret" },
        tools: ["list", "read"],
        cwd: "/tmp/run",
      },
    ]);
    expect(flags).toContain("mcp_servers.full.command=binary");
    expect(flags).toContain('mcp_servers.full.args=["--flag"]');
    expect(flags).toContain('mcp_servers.full.env={"TOKEN":"secret"}');
    expect(flags).toContain('mcp_servers.full.enabled_tools=["list","read"]');
    expect(flags).toContain("mcp_servers.full.cwd=/tmp/run");
  });
});
