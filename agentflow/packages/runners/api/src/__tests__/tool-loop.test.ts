import { describe, expect, it, vi } from "vitest";
import { MaxToolRoundsError, ToolNotFoundError } from "../errors.js";
import type { ChatCompletionResponse } from "../openai-types.js";
import { runToolLoop } from "../tool-loop.js";
import type { ToolRegistry } from "../types.js";

function makeResponse(body: ChatCompletionResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const terminalAssistant: ChatCompletionResponse = {
  choices: [
    {
      message: { role: "assistant", content: "done", tool_calls: undefined },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

describe("runToolLoop", () => {
  it("returns assistant content when no tool_calls", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse(terminalAssistant));
    const res = await runToolLoop({
      baseUrl: "https://example",
      apiKey: "k",
      headers: {},
      fetch: fetchMock as unknown as typeof fetch,
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: undefined,
      registry: {},
      maxRounds: 10,
      requestTimeout: 1000,
    });
    expect(res.finalText).toBe("done");
    expect(res.toolCalls).toEqual([]);
    expect(res.tokensIn).toBe(3);
    expect(res.tokensOut).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("executes a tool, sends result back, sums tokens across rounds", async () => {
    const withToolCall: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "echo",
                  arguments: JSON.stringify({ s: "hi" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(withToolCall))
      .mockResolvedValueOnce(makeResponse(terminalAssistant));

    const registry: ToolRegistry = {
      echo: {
        description: "echo",
        parameters: { type: "object" },
        execute: ({ s }) => `echoed:${s as string}`,
      },
    };

    const res = await runToolLoop({
      baseUrl: "https://example",
      apiKey: "k",
      headers: {},
      fetch: fetchMock as unknown as typeof fetch,
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "echo", description: "echo", parameters: {} },
        },
      ],
      registry,
      maxRounds: 10,
      requestTimeout: 1000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.finalText).toBe("done");
    expect(res.toolCalls.length).toBe(1);
    expect(res.toolCalls[0]?.name).toBe("echo");
    expect(res.toolCalls[0]?.args).toEqual({ s: "hi" });
    expect(res.toolCalls[0]?.result).toBe("echoed:hi");
    expect(res.tokensIn).toBe(13); // 10 + 3
    expect(res.tokensOut).toBe(7); // 5 + 2
  });

  it("catches tool errors and feeds them back to the model", async () => {
    const withToolCall: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_err",
                type: "function",
                function: { name: "boom", arguments: "{}" },
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
      .mockResolvedValueOnce(makeResponse(withToolCall))
      .mockResolvedValueOnce(makeResponse(terminalAssistant));

    const registry: ToolRegistry = {
      boom: {
        description: "",
        parameters: {},
        execute: () => {
          throw new Error("kaboom");
        },
      },
    };

    const res = await runToolLoop({
      baseUrl: "https://example",
      apiKey: "k",
      headers: {},
      fetch: fetchMock as unknown as typeof fetch,
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: undefined,
      registry,
      maxRounds: 10,
      requestTimeout: 1000,
    });
    expect(res.toolCalls[0]?.result).toMatch(/kaboom/);
  });

  it("throws ToolNotFoundError when model calls unknown tool", async () => {
    const withUnknownToolCall: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_unknown",
                type: "function",
                function: { name: "nonexistent", arguments: "{}" },
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
      .mockResolvedValueOnce(makeResponse(withUnknownToolCall));
    const registry: ToolRegistry = {};

    await expect(
      runToolLoop({
        baseUrl: "https://example",
        apiKey: "k",
        headers: {},
        fetch: fetchMock as unknown as typeof fetch,
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: undefined,
        registry,
        maxRounds: 10,
        requestTimeout: 1000,
      }),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it("P2-7: handles missing usage field (defaults to 0) for servers that omit it", async () => {
    const noUsage = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "done",
            tool_calls: undefined,
          },
          finish_reason: "stop",
        },
      ],
      // usage intentionally omitted (Ollama-style)
    } as unknown as ChatCompletionResponse;
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(noUsage));
    const res = await runToolLoop({
      baseUrl: "https://example",
      apiKey: "k",
      headers: {},
      fetch: fetchMock as unknown as typeof fetch,
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      tools: undefined,
      registry: {},
      maxRounds: 10,
      requestTimeout: 1000,
    });
    expect(res.tokensIn).toBe(0);
    expect(res.tokensOut).toBe(0);
    expect(res.finalText).toBe("done");
  });

  it("throws MaxToolRoundsError when ceiling exceeded", async () => {
    const withToolCall: ChatCompletionResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_loop",
                type: "function",
                function: { name: "noop", arguments: "{}" },
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
      .mockImplementation(() => Promise.resolve(makeResponse(withToolCall)));
    const registry: ToolRegistry = {
      noop: { description: "", parameters: {}, execute: () => "ok" },
    };

    await expect(
      runToolLoop({
        baseUrl: "https://example",
        apiKey: "k",
        headers: {},
        fetch: fetchMock as unknown as typeof fetch,
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: undefined,
        registry,
        maxRounds: 2,
        requestTimeout: 1000,
      }),
    ).rejects.toBeInstanceOf(MaxToolRoundsError);
  });
});
