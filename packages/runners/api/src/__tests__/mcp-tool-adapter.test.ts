import type { McpServerConfig } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpClient } from "../mcp-client.js";
import {
  McpToolArgInvalidError,
  mcpToolsToRegistry,
} from "../mcp-tool-adapter.js";

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

// ─── Issue #84 Item 34: refine schema runtime guard ──────────────────────────

describe("mcp-tool-adapter refine schema runtime guard (issue #84 item 34)", () => {
  it("throws McpToolArgInvalidError (not TypeError) when refine value is a plain object, not a Zod schema", async () => {
    // Simulate user passing `refine: { read_file: {} }` — not a Zod schema
    const clientWithBadRefine: McpClient = {
      config: {
        name: "fs",
        command: "x",
        tools: ["read_file"],
        // biome-ignore lint/suspicious/noExplicitAny: intentionally testing invalid config
        refine: { read_file: {} as any },
      },
      async listTools() {
        return [
          {
            name: "read_file",
            description: "",
            inputSchema: { type: "object" },
          },
        ];
      },
      async callTool(name, args) {
        return { called: name, args };
      },
      async stop() {},
    };

    const reg = await mcpToolsToRegistry([clientWithBadRefine]);
    // biome-ignore lint/complexity/useLiteralKeys: key contains double underscores, bracket access is clearer
    // biome-ignore lint/style/noNonNullAssertion: known to exist due to prior assertion
    const readFileTool = reg["mcp__fs__read_file"]!;

    // Must throw McpToolArgInvalidError with a helpful message, NOT TypeError
    await expect(readFileTool.execute({ path: "/tmp/test" })).rejects.toThrow(
      McpToolArgInvalidError,
    );
    await expect(readFileTool.execute({ path: "/tmp/test" })).rejects.toThrow(
      /not a Zod schema/i,
    );
    // Must NOT propagate as a raw TypeError
    await expect(
      readFileTool.execute({ path: "/tmp/test" }),
    ).rejects.not.toThrow(TypeError);
  });

  it("rejects refine: { tool: null } with McpToolArgInvalidError mentioning 'null'", async () => {
    const clientWithNullRefine: McpClient = {
      config: {
        name: "fs",
        command: "x",
        tools: ["read_file"],
        // biome-ignore lint/suspicious/noExplicitAny: intentionally testing invalid config
        refine: { read_file: null as any },
      },
      async listTools() {
        return [
          {
            name: "read_file",
            description: "",
            inputSchema: { type: "object" },
          },
        ];
      },
      async callTool(name, args) {
        return { called: name, args };
      },
      async stop() {},
    };

    const reg = await mcpToolsToRegistry([clientWithNullRefine]);
    // biome-ignore lint/complexity/useLiteralKeys: key contains double underscores, bracket access is clearer
    // biome-ignore lint/style/noNonNullAssertion: known to exist due to prior assertion
    const readFileTool = reg["mcp__fs__read_file"]!;

    await expect(readFileTool.execute({ path: "/tmp/test" })).rejects.toThrow(
      McpToolArgInvalidError,
    );
    await expect(readFileTool.execute({ path: "/tmp/test" })).rejects.toThrow(
      /null/i,
    );
  });

  it("rejects refine: { tool: 'string' } with McpToolArgInvalidError mentioning 'string'", async () => {
    const clientWithStringRefine: McpClient = {
      config: {
        name: "fs",
        command: "x",
        tools: ["read_file"],
        // biome-ignore lint/suspicious/noExplicitAny: intentionally testing invalid config
        refine: { read_file: "not a schema" as any },
      },
      async listTools() {
        return [
          {
            name: "read_file",
            description: "",
            inputSchema: { type: "object" },
          },
        ];
      },
      async callTool(name, args) {
        return { called: name, args };
      },
      async stop() {},
    };

    const reg = await mcpToolsToRegistry([clientWithStringRefine]);
    // biome-ignore lint/complexity/useLiteralKeys: key contains double underscores, bracket access is clearer
    // biome-ignore lint/style/noNonNullAssertion: known to exist due to prior assertion
    const readFileTool = reg["mcp__fs__read_file"]!;

    await expect(readFileTool.execute({ path: "/tmp/test" })).rejects.toThrow(
      McpToolArgInvalidError,
    );
    await expect(readFileTool.execute({ path: "/tmp/test" })).rejects.toThrow(
      /string/i,
    );
  });

  it("rejects refine: { tool: 42 } with McpToolArgInvalidError mentioning 'number'", async () => {
    const clientWithNumberRefine: McpClient = {
      config: {
        name: "fs",
        command: "x",
        tools: ["read_file"],
        // biome-ignore lint/suspicious/noExplicitAny: intentionally testing invalid config
        refine: { read_file: 42 as any },
      },
      async listTools() {
        return [
          {
            name: "read_file",
            description: "",
            inputSchema: { type: "object" },
          },
        ];
      },
      async callTool(name, args) {
        return { called: name, args };
      },
      async stop() {},
    };

    const reg = await mcpToolsToRegistry([clientWithNumberRefine]);
    // biome-ignore lint/complexity/useLiteralKeys: key contains double underscores, bracket access is clearer
    // biome-ignore lint/style/noNonNullAssertion: known to exist due to prior assertion
    const readFileTool = reg["mcp__fs__read_file"]!;

    await expect(readFileTool.execute({ path: "/tmp/test" })).rejects.toThrow(
      McpToolArgInvalidError,
    );
    await expect(readFileTool.execute({ path: "/tmp/test" })).rejects.toThrow(
      /number/i,
    );
  });
});
