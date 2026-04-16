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
    expect(flags).toContain('mcp_servers.filesystem.env={FOO="bar"}');
    expect(flags).toContain('mcp_servers.filesystem.tools=["read_file"]');
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
    expect(hasArgs).toBe(false);
    expect(hasEnv).toBe(false);
    expect(hasTools).toBe(false);
  });
});
