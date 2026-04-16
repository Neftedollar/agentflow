/**
 * api-runner.mcp.test.ts
 *
 * End-to-end test: ApiRunner.spawn() with a real mock MCP server subprocess.
 * Mocks fetch to drive a tool_call → terminal assistant sequence.
 */

import { describe, expect, it, vi } from "vitest";
import { ApiRunner } from "../api-runner.js";
import type { ChatCompletionResponse } from "../openai-types.js";
import { spawnMockMcpServer } from "@ageflow/testing";

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
      tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
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

    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResp(terminalResponse));

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
