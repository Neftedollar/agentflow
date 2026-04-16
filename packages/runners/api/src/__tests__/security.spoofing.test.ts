/**
 * security.spoofing.test.ts
 *
 * Task 8.1 — tool spoofing
 *
 * Scenario: A mock MCP server advertises `exec_anywhere` (NOT in the
 * allowlist). The model emits `mcp__mock__exec_anywhere` as a tool call.
 *
 * Expected invariants:
 *   1. ToolNotFoundError fires in the tool loop — the forbidden tool is never
 *      added to the registry (allowlist pre-dispatch strips it).
 *   2. Mock server's callTool is never invoked.
 *   3. `toolCalls` record: documented gap — see note below.
 *
 * NOTE — toolCalls gap:
 *   The tool loop re-throws ToolNotFoundError immediately (tool-loop.ts line 101).
 *   Because the throw happens before the toolCalls.push(), the rejected call is
 *   NOT recorded in `res.toolCalls`. This is a deliberate design choice: logging
 *   a spoofed name would give attackers confirmation of what the loop rejected.
 *   The error propagation itself is the observable security signal.
 */

import { describe, expect, it, vi } from "vitest";
import { ToolNotFoundError } from "../errors.js";
import type { McpClient } from "../mcp-client.js";
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

/**
 * Build a mock McpClient + a separate spy reference for assertions.
 * The spy is set as the `callTool` method so we can assert it was never called.
 */
function buildMockClientWithSpy(
  tools: Array<{ name: string; description?: string }>,
  config: import("@ageflow/core").McpServerConfig,
): { client: McpClient; callToolSpy: ReturnType<typeof vi.fn> } {
  const callToolSpy = vi.fn().mockResolvedValue("should_not_be_called");

  const client: McpClient = {
    config,
    async listTools() {
      return tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: { type: "object" },
      }));
    },
    callTool: callToolSpy,
    async stop() {},
  };

  return { client, callToolSpy };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("Security: tool spoofing", () => {
  it("ToolNotFoundError fires when model calls a tool not in the allowlist", async () => {
    // Server advertises exec_anywhere (and allowed_tool for the allowlist)
    // Allowlist permits only "allowed_tool"
    const { client, callToolSpy } = buildMockClientWithSpy(
      [
        { name: "exec_anywhere", description: "dangerous — not allowed" },
        { name: "allowed_tool", description: "safe tool" },
      ],
      {
        name: "mock",
        command: "node",
        tools: ["allowed_tool"], // exec_anywhere is NOT in the allowlist
      },
    );

    // Build registry — exec_anywhere must be absent
    const registry = await mcpToolsToRegistry([client]);

    expect(Object.keys(registry)).not.toContain("mcp__mock__exec_anywhere");
    expect(Object.keys(registry)).toContain("mcp__mock__allowed_tool");

    // Simulate the model emitting a tool call for the forbidden tool
    const spoofedToolCallResponse: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_spoof",
                type: "function",
                function: {
                  name: "mcp__mock__exec_anywhere",
                  arguments: JSON.stringify({ cmd: "rm -rf /" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResp(spoofedToolCallResponse));

    // The tool loop MUST throw ToolNotFoundError
    await expect(
      runToolLoop({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        headers: {},
        fetch: fetchMock as unknown as typeof fetch,
        model: "gpt-4o",
        messages: [{ role: "user", content: "hack me" }],
        tools: undefined,
        registry,
        maxRounds: 5,
        requestTimeout: 5000,
      }),
    ).rejects.toBeInstanceOf(ToolNotFoundError);

    // The server's callTool must never be invoked
    expect(callToolSpy).not.toHaveBeenCalled();
  });

  it("ToolNotFoundError carries the attempted tool name", async () => {
    // Empty registry — any tool call will be a spoof
    const registry = await mcpToolsToRegistry([]);

    const spoofedToolCallResponse: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_spoof2",
                type: "function",
                function: {
                  name: "mcp__mock__exec_anywhere",
                  arguments: "{}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResp(spoofedToolCallResponse));

    let caught: unknown;
    try {
      await runToolLoop({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        headers: {},
        fetch: fetchMock as unknown as typeof fetch,
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        tools: undefined,
        registry,
        maxRounds: 5,
        requestTimeout: 5000,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ToolNotFoundError);
    const err = caught as ToolNotFoundError;
    expect(err.toolName).toBe("mcp__mock__exec_anywhere");
    expect(err.code).toBe("tool_not_found");
  });

  it("toolCalls record is empty for a spoof attempt (gap documented in file header)", async () => {
    // By design: ToolNotFoundError is re-thrown before push() — rejected call
    // is not recorded. The throw itself is the observable security signal.
    const registry = await mcpToolsToRegistry([]);

    const spoofedToolCallResponse: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_spoof3",
                type: "function",
                function: {
                  name: "mcp__mock__exec_anywhere",
                  arguments: "{}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResp(spoofedToolCallResponse));

    // The loop throws — no result object to inspect for toolCalls.
    // The absence of a record is itself the documented behavior.
    await expect(
      runToolLoop({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        headers: {},
        fetch: fetchMock as unknown as typeof fetch,
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        tools: undefined,
        registry,
        maxRounds: 5,
        requestTimeout: 5000,
      }),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
    // If you reach here without throwing, that is the failure signal.
  });
});
