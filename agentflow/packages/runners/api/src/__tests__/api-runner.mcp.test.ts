/**
 * api-runner.mcp.test.ts
 *
 * End-to-end test: ApiRunner.spawn() with a real mock MCP server subprocess.
 * Mocks fetch to drive a tool_call → terminal assistant sequence.
 */

import type { Logger } from "@ageflow/core";
import { spawnMockMcpServer } from "@ageflow/testing";
import { describe, expect, it, vi } from "vitest";
import { ApiRunner } from "../api-runner.js";
import type { McpClient } from "../mcp-client.js";
import type { ChatCompletionResponse } from "../openai-types.js";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ApiRunner.spawn with MCP", () => {
  it("routes mcp__mock__echo tool call through the MCP subprocess", async () => {
    // Start a real mock MCP server subprocess
    const subCmd = spawnMockMcpServer.asSubprocessCommand({
      tools: [
        { name: "echo", description: "echo", inputSchema: { type: "object" } },
      ],
    });

    // Sequence: first response has a tool_call for mcp__mock__echo, then terminal
    const toolCallResponse: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call1",
                type: "function",
                function: {
                  name: "mcp__mock__echo",
                  arguments: JSON.stringify({ text: "hello" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };

    const terminalResponse: ChatCompletionResponse = {
      choices: [
        {
          message: { role: "assistant", content: "done with echo" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    };

    let callIdx = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResp(callIdx++ === 0 ? toolCallResponse : terminalResponse),
        ),
      );

    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({
      prompt: "use echo",
      model: "gpt-4o",
      mcpServers: [
        {
          name: "mock",
          command: subCmd.command,
          args: [...subCmd.args],
        },
      ],
    });

    // Assert final output
    expect(res.stdout).toBe("done with echo");

    // Assert tool call was recorded
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls?.[0]?.name).toBe("mcp__mock__echo");

    // Runner should expose shutdown()
    await runner.shutdown();
  });

  it("runner.shutdown() stops pooled MCP clients", async () => {
    const subCmd = spawnMockMcpServer.asSubprocessCommand({
      tools: [{ name: "ping", description: "", inputSchema: {} }],
    });

    const terminalResponse: ChatCompletionResponse = {
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    };

    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalResponse));

    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
    });

    // Spawn with reusePerRunner so it goes into the pool
    await runner.spawn({
      prompt: "test",
      model: "gpt-4o",
      mcpServers: [
        {
          name: "pooled",
          command: subCmd.command,
          args: [...subCmd.args],
          reusePerRunner: true,
        },
      ],
    });

    // shutdown() should drain the pool without throwing
    await expect(runner.shutdown()).resolves.toBeUndefined();
  });
});

// ─── Issue #71: ApiRunnerConfig.logger threaded to startMcpClients ────────────

describe("ApiRunner logger config (issue #71)", () => {
  it(
    "forwards ApiRunnerConfig.logger to MCP subprocess stderr",
    async () => {
      // A crashing MCP server emits stderr before dying. The logger injected
      // via ApiRunnerConfig must receive that stderr output.
      const crashCmd = spawnMockMcpServer.asSubprocessCommand({
        tools: [],
        crashOn: "initialize",
      });

      const mockLogger: Logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const fetchMock = vi.fn();

      const runner = new ApiRunner({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        defaultModel: "gpt-4o",
        fetch: fetchMock as unknown as typeof fetch,
        logger: mockLogger,
      });

      // spawn must fail because the MCP server crashes on initialize
      await expect(
        runner.spawn({
          prompt: "test",
          model: "gpt-4o",
          mcpServers: [
            {
              name: "crashing",
              command: crashCmd.command,
              args: [...crashCmd.args],
            },
          ],
        }),
      ).rejects.toThrow(/mcp_server_start_failed/i);

      // Logger must have received the stderr from the crashing subprocess
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("[mcp:crashing]"),
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("crashing on initialize"),
      );
    },
    { timeout: 5_000 },
  );
});

// ─── Issue #84 Item 7: partial MCP startup leak guard ────────────────────────

describe("ApiRunner MCP startup partial-failure leak guard (issue #84 item 7)", () => {
  it(
    "stops already-started non-pooled clients when a later server fails to start",
    async () => {
      // Build a fake McpClient whose stop() we can spy on
      const stopSpy = vi.fn().mockResolvedValue(undefined);
      const fakeClient: McpClient = {
        config: { name: "server-a", command: "x" },
        async listTools() {
          return [];
        },
        async callTool() {
          return {};
        },
        stop: stopSpy,
      };

      // Patch the mcp-client module so:
      //   first call to startMcpClients → resolves with fakeClient
      //   second call to startMcpClients → rejects
      const mcpClientMod = await import("../mcp-client.js");
      const startSpy = vi
        .spyOn(mcpClientMod, "startMcpClients")
        .mockResolvedValueOnce([fakeClient])
        .mockRejectedValueOnce(
          new mcpClientMod.McpServerStartFailedError(
            "server-b",
            new Error("spawn failed"),
          ),
        );

      const fetchMock = vi.fn();
      const runner = new ApiRunner({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        defaultModel: "gpt-4o",
        fetch: fetchMock as unknown as typeof fetch,
      });

      // Two non-pooled servers: server-a starts, server-b fails
      await expect(
        runner.spawn({
          prompt: "test",
          model: "gpt-4o",
          mcpServers: [
            { name: "server-a", command: "cmd-a" },
            { name: "server-b", command: "cmd-b" },
          ],
        }),
      ).rejects.toThrow(/mcp_server_start_failed/i);

      // server-a's stop() must have been called — no subprocess leak
      expect(stopSpy).toHaveBeenCalledTimes(1);

      startSpy.mockRestore();
    },
    { timeout: 5_000 },
  );
});
