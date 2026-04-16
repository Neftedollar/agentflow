import type { McpServerConfig } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpClient } from "../mcp-client.js";
import { mcpToolsToRegistry } from "../mcp-tool-adapter.js";

function mockClient(cfg: Partial<McpServerConfig>): McpClient {
  return {
    config: { name: "fs", command: "x", ...cfg },
    async listTools() {
      return [
        { name: "read_file", description: "", inputSchema: { type: "object" } },
        { name: "delete_file", description: "", inputSchema: {} },
      ];
    },
    async callTool(name, args) {
      return { called: name, args };
    },
    async stop() {},
  };
}

describe("mcpToolsToRegistry", () => {
  it("namespace-mangles tool names to mcp__<srv>__<tool>", async () => {
    const reg = await mcpToolsToRegistry([mockClient({})]);
    expect(Object.keys(reg)).toEqual([
      "mcp__fs__read_file",
      "mcp__fs__delete_file",
    ]);
  });

  it("filters by server.tools allowlist (pre-dispatch)", async () => {
    const reg = await mcpToolsToRegistry([
      mockClient({ tools: ["read_file"] }),
    ]);
    expect(Object.keys(reg)).toEqual(["mcp__fs__read_file"]);
  });

  it("post-dispatch double-check: model cannot bypass allowlist", async () => {
    // Build registry with allowlist; simulate the model calling a non-listed tool.
    // Registry won't contain `mcp__fs__delete_file`, so the tool-loop will hit
    // ToolNotFoundError. Assert the error maps to MCP_TOOL_NOT_PERMITTED.
    const reg = await mcpToolsToRegistry([
      mockClient({ tools: ["read_file"] }),
    ]);
    // biome-ignore lint/complexity/useLiteralKeys: key contains double underscores, bracket access is clearer
    expect(reg["mcp__fs__delete_file"]).toBeUndefined();
  });

  it("applies `refine` schemas before calling the server", async () => {
    const reg = await mcpToolsToRegistry([
      mockClient({
        tools: ["read_file"],
        refine: {
          read_file: z.object({
            path: z.string().refine((p) => !p.startsWith("/etc")),
          }),
        },
      }),
    ]);
    // biome-ignore lint/complexity/useLiteralKeys: key contains double underscores, bracket access is clearer
    // biome-ignore lint/style/noNonNullAssertion: known to exist due to prior assertion
    const readFileTool = reg["mcp__fs__read_file"]!;
    await expect(readFileTool.execute({ path: "/etc/passwd" })).rejects.toThrow(
      /mcp_tool_arg_invalid/i,
    );
  });
});
