/**
 * security.path-escape.test.ts
 *
 * Task 8.2 — path escape via `safePath`
 *
 * Scenario: An MCP server config uses
 *   `refine: { read_file: z.object({ path: safePath({ allowAbsolute: false }) }) }`
 * The model emits `{ path: "../../../etc/passwd" }`.
 *
 * Expected invariants:
 *   1. `McpToolArgInvalidError` surfaces — returned to the model as a
 *      tool-role error message (the loop catches non-ToolNotFoundError errors
 *      and feeds them back as tool results rather than aborting).
 *   2. Server's `callTool` is never invoked.
 *
 * Design note:
 *   Path escape rejection happens inside the ToolDefinition.execute() that
 *   mcpToolsToRegistry() builds. The McpToolArgInvalidError is NOT a
 *   ToolNotFoundError, so tool-loop.ts catches it and feeds the error message
 *   back to the model as a tool-role message. The model then has a chance to
 *   correct its path — this is the intentional behaviour (Zod as security
 *   boundary, error returned to model rather than crashing the loop).
 */

import { safePath } from "@ageflow/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpClient } from "../mcp-client.js";
import { McpToolArgInvalidError } from "../mcp-tool-adapter.js";
import { mcpToolsToRegistry } from "../mcp-tool-adapter.js";
import type { ChatCompletionResponse } from "../openai-types.js";
import { runToolLoop } from "../tool-loop.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildMockClient(
  config: import("@ageflow/core").McpServerConfig,
  callToolSpy: ReturnType<typeof vi.fn>,
): McpClient {
  return {
    config,
    async listTools() {
      return [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ];
    },
    callTool: callToolSpy,
    async stop() {},
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("Security: path escape via safePath refine", () => {
  it("McpToolArgInvalidError is returned to the model when path contains traversal", async () => {
    const callToolSpy = vi.fn().mockResolvedValue("should_not_be_called");

    const client = buildMockClient(
      {
        name: "fs",
        command: "node",
        refine: {
          read_file: z.object({ path: safePath({ allowAbsolute: false }) }),
        },
      },
      callToolSpy,
    );

    const registry = await mcpToolsToRegistry([client]);
    expect(Object.keys(registry)).toContain("mcp__fs__read_file");

    // Model calls read_file with a path traversal payload
    const pathEscapeResponse: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_path",
                type: "function",
                function: {
                  name: "mcp__fs__read_file",
                  arguments: JSON.stringify({ path: "../../../etc/passwd" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };

    // Terminal response after the model receives the error
    const terminalResponse: ChatCompletionResponse = {
      choices: [
        {
          message: { role: "assistant", content: "I cannot read that file." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
    };

    let callIdx = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResp(callIdx++ === 0 ? pathEscapeResponse : terminalResponse),
        ),
      );

    const res = await runToolLoop({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      headers: {},
      fetch: fetchMock as unknown as typeof fetch,
      model: "gpt-4o",
      messages: [{ role: "user", content: "read /etc/passwd" }],
      tools: undefined,
      registry,
      maxRounds: 5,
      requestTimeout: 5000,
    });

    // The loop completes (error is fed back to the model, not thrown)
    expect(res.finalText).toBe("I cannot read that file.");

    // The tool call result must contain the McpToolArgInvalidError message
    expect(res.toolCalls).toHaveLength(1);
    const record = res.toolCalls[0];
    expect(typeof record?.result).toBe("string");
    expect(record?.result as string).toMatch(/mcp_tool_arg_invalid/i);

    // The server's callTool MUST NOT have been invoked
    expect(callToolSpy).not.toHaveBeenCalled();
  });

  it("direct adapter: McpToolArgInvalidError thrown synchronously before server call", async () => {
    // Test the adapter layer directly without the tool loop, to confirm the
    // error is thrown (not returned) at the execute() boundary.
    const callToolSpy = vi.fn().mockResolvedValue("never");

    const client = buildMockClient(
      {
        name: "fs",
        command: "node",
        refine: {
          read_file: z.object({ path: safePath({ allowAbsolute: false }) }),
        },
      },
      callToolSpy,
    );

    const registry = await mcpToolsToRegistry([client]);
    // biome-ignore lint/complexity/useLiteralKeys: bracket access is clearer for double-underscore keys
    const readFileTool = registry["mcp__fs__read_file"];
    expect(readFileTool).toBeDefined();

    await expect(
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above
      readFileTool!.execute({ path: "../../../etc/passwd" }),
    ).rejects.toBeInstanceOf(McpToolArgInvalidError);

    // Verify error code
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    await readFileTool!.execute({ path: "safe/relative/path" }).catch(() => {});
    // callTool should only be called for valid paths
    expect(callToolSpy).toHaveBeenCalledWith("read_file", {
      path: "safe/relative/path",
    });

    // Reset and verify traversal was rejected
    callToolSpy.mockClear();
    try {
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above
      await readFileTool!.execute({ path: "../../../etc/passwd" });
    } catch (err) {
      expect(err).toBeInstanceOf(McpToolArgInvalidError);
      const invalid = err as McpToolArgInvalidError;
      expect(invalid.code).toBe("mcp_tool_arg_invalid");
      expect(invalid.toolName).toBe("read_file");
    }
    expect(callToolSpy).not.toHaveBeenCalled();
  });

  it("direct adapter: absolute path blocked when allowAbsolute: false", async () => {
    const callToolSpy = vi.fn().mockResolvedValue("never");

    const client = buildMockClient(
      {
        name: "fs",
        command: "node",
        refine: {
          read_file: z.object({ path: safePath({ allowAbsolute: false }) }),
        },
      },
      callToolSpy,
    );

    const registry = await mcpToolsToRegistry([client]);
    // biome-ignore lint/complexity/useLiteralKeys: bracket access is clearer for double-underscore keys
    // biome-ignore lint/style/noNonNullAssertion: index access cannot be narrowed; registry populated by mcpToolsToRegistry
    const readFileTool = registry["mcp__fs__read_file"]!;

    await expect(
      readFileTool.execute({ path: "/etc/passwd" }),
    ).rejects.toBeInstanceOf(McpToolArgInvalidError);

    expect(callToolSpy).not.toHaveBeenCalled();
  });
});
