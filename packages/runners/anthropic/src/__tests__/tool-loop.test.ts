import type { ToolRegistry } from "@ageflow/runner-api";
import { describe, expect, it, vi } from "vitest";
import type { AnthropicResponse } from "../anthropic-types.js";
import { MaxToolRoundsError, ToolNotFoundError } from "../errors.js";
import { runAnthropicToolLoop } from "../tool-loop.js";

function makeResponse(body: AnthropicResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const endTurnResponse: AnthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "claude-3-5-sonnet-20241022",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 3 },
};

describe("runAnthropicToolLoop", () => {
  it("returns assistant text on end_turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(endTurnResponse));
    const res = await runAnthropicToolLoop({
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof fetch,
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "hi" }],
      system: undefined,
      tools: undefined,
      registry: {},
      maxRounds: 10,
      maxTokens: 8192,
      requestTimeout: 5000,
    });
    expect(res.finalText).toBe("done");
    expect(res.tokensIn).toBe(5);
    expect(res.tokensOut).toBe(3);
    expect(res.toolCalls).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends x-api-key and anthropic-version headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(endTurnResponse));
    await runAnthropicToolLoop({
      apiKey: "my-secret",
      fetch: fetchMock as unknown as typeof fetch,
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "hi" }],
      system: undefined,
      tools: undefined,
      registry: {},
      maxRounds: 10,
      maxTokens: 8192,
      requestTimeout: 5000,
    });
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("my-secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("puts system prompt in request body system field, not in messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(endTurnResponse));
    await runAnthropicToolLoop({
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "hi" }],
      system: "be concise",
      tools: undefined,
      registry: {},
      maxRounds: 10,
      maxTokens: 8192,
      requestTimeout: 5000,
    });
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe("be concise");
    // messages should not have a system role
    const hasSystemMsg = (body.messages as Array<{ role: string }>).some(
      (m) => m.role === "system",
    );
    expect(hasSystemMsg).toBe(false);
  });

  it("executes a tool and sends tool_result back, sums tokens", async () => {
    const toolUseResponse: AnthropicResponse = {
      id: "msg_2",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "echo",
          input: { s: "hi" },
        },
      ],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(toolUseResponse))
      .mockResolvedValueOnce(makeResponse(endTurnResponse));

    const registry: ToolRegistry = {
      echo: {
        description: "echo",
        parameters: { type: "object" },
        execute: ({ s }) => `echoed:${s as string}`,
      },
    };

    const res = await runAnthropicToolLoop({
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "echo hi" }],
      system: undefined,
      tools: [
        {
          name: "echo",
          description: "echo",
          input_schema: { type: "object" },
        },
      ],
      registry,
      maxRounds: 10,
      maxTokens: 8192,
      requestTimeout: 5000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.finalText).toBe("done");
    expect(res.toolCalls.length).toBe(1);
    expect(res.toolCalls[0]?.name).toBe("echo");
    expect(res.toolCalls[0]?.result).toBe("echoed:hi");
    expect(res.tokensIn).toBe(15); // 10 + 5
    expect(res.tokensOut).toBe(8); // 5 + 3

    // Second fetch should have a user message with tool_result
    const [_url2, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body2 = JSON.parse(init2.body as string);
    const lastMsg = body2.messages[body2.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content[0].type).toBe("tool_result");
    expect(lastMsg.content[0].tool_use_id).toBe("tu_1");
    expect(lastMsg.content[0].content).toBe("echoed:hi");
  });

  it("throws ToolNotFoundError when model calls unknown tool", async () => {
    const toolUseResponse: AnthropicResponse = {
      id: "msg_3",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_x",
          name: "nonexistent",
          input: {},
        },
      ],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 2 },
    };

    const fetchMock = vi.fn().mockResolvedValue(makeResponse(toolUseResponse));
    await expect(
      runAnthropicToolLoop({
        apiKey: "k",
        fetch: fetchMock as unknown as typeof fetch,
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "hi" }],
        system: undefined,
        tools: undefined,
        registry: {},
        maxRounds: 10,
        maxTokens: 8192,
        requestTimeout: 5000,
      }),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it("throws MaxToolRoundsError when ceiling exceeded", async () => {
    const toolUseResponse: AnthropicResponse = {
      id: "msg_loop",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_loop",
          name: "noop",
          input: {},
        },
      ],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(makeResponse(toolUseResponse)));

    const registry: ToolRegistry = {
      noop: { description: "", parameters: {}, execute: () => "ok" },
    };

    await expect(
      runAnthropicToolLoop({
        apiKey: "k",
        fetch: fetchMock as unknown as typeof fetch,
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "loop" }],
        system: undefined,
        tools: undefined,
        registry,
        maxRounds: 2,
        maxTokens: 8192,
        requestTimeout: 5000,
      }),
    ).rejects.toBeInstanceOf(MaxToolRoundsError);
  });

  it("catches tool errors and feeds them back to the model", async () => {
    const toolUseResponse: AnthropicResponse = {
      id: "msg_err",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_err",
          name: "boom",
          input: {},
        },
      ],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(toolUseResponse))
      .mockResolvedValueOnce(makeResponse(endTurnResponse));

    const registry: ToolRegistry = {
      boom: {
        description: "",
        parameters: {},
        execute: () => {
          throw new Error("kaboom");
        },
      },
    };

    const res = await runAnthropicToolLoop({
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "boom" }],
      system: undefined,
      tools: undefined,
      registry,
      maxRounds: 10,
      maxTokens: 8192,
      requestTimeout: 5000,
    });

    expect(res.toolCalls[0]?.result).toMatch(/kaboom/);

    // The tool_result content should contain the error
    const [_url2, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body2 = JSON.parse(init2.body as string);
    const lastMsg = body2.messages[body2.messages.length - 1];
    expect(lastMsg.content[0].content).toMatch(/kaboom/);
  });

  it("uses extended thinking when thinkingBudgetTokens is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(endTurnResponse));
    await runAnthropicToolLoop({
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      model: "claude-3-7-sonnet-20250219",
      messages: [{ role: "user", content: "think" }],
      system: undefined,
      tools: undefined,
      registry: {},
      maxRounds: 10,
      maxTokens: 16000,
      requestTimeout: 5000,
      thinkingBudgetTokens: 10000,
    });
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });
});
