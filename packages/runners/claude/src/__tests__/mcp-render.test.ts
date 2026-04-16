import { describe, expect, it } from "vitest";
import { renderMcpJson } from "../mcp-render.js";

describe("renderMcpJson", () => {
  it("returns an empty mcpServers object for []", () => {
    expect(renderMcpJson([])).toEqual({ mcpServers: {} });
  });

  it("maps McpServerConfig to Claude CLI's expected shape", () => {
    const json = renderMcpJson([
      {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { NODE_OPTIONS: "--max-old-space-size=512" },
      },
    ]);
    expect(json).toEqual({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { NODE_OPTIONS: "--max-old-space-size=512" },
        },
      },
    });
  });

  it("omits env when empty", () => {
    const json = renderMcpJson([{ name: "x", command: "y" }]);
    expect(json.mcpServers.x).toEqual({ command: "y" });
  });

  it("does NOT leak tools allowlist into the JSON (that goes via CLI flags)", () => {
    const json = renderMcpJson([{ name: "x", command: "y", tools: ["a"] }]);
    expect(json.mcpServers.x).toEqual({ command: "y" });
  });
});
