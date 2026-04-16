import { describe, expect, it, vi } from "vitest";
import { ApiRunner } from "../api-runner.js";
import { ToolNotFoundError } from "../errors.js";
import type { ChatCompletionResponse } from "../openai-types.js";
import { InMemorySessionStore } from "../session-store.js";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const terminalAssistant: ChatCompletionResponse = {
  choices: [
    {
      message: { role: "assistant", content: "hello world" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
};

describe("ApiRunner.spawn", () => {
  it("performs a single completion and returns stdout + token counts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({
      prompt: "say hi",
      model: "gpt-4o",
      sessionHandle: undefined,
    });

    expect(res.stdout).toBe("hello world");
    expect(res.tokensIn).toBe(4);
    expect(res.tokensOut).toBe(3);
    expect(res.sessionHandle.length).toBeGreaterThan(0);
    expect(res.toolCalls).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses defaultModel when args.model is not set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o-mini",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await runner.spawn({ prompt: "x" });
    const firstCall = fetchMock.mock.calls[0];
    const body = JSON.parse(firstCall?.[1]?.body as string) as {
      model: string;
    };
    expect(body.model).toBe("gpt-4o-mini");
  });

  it("persists history to the session store under sessionHandle", async () => {
    const store = new InMemorySessionStore();
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      sessionStore: store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const first = await runner.spawn({ prompt: "p1" });
    const history = await store.get(first.sessionHandle);
    expect(history?.length).toBeGreaterThanOrEqual(2); // user + assistant
  });

  it("resumes when sessionHandle is provided", async () => {
    const store = new InMemorySessionStore();
    await store.set("existing", [
      { role: "system", content: "sys" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      sessionStore: store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({
      prompt: "next",
      sessionHandle: "existing",
    });
    expect(res.sessionHandle).toBe("existing");

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.length).toBe(4); // system + earlier user + earlier assistant + next user
    expect(body.messages[3]?.content).toBe("next");
  });

  it("injects systemPrompt when provided and no prior system message exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(terminalAssistant));
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await runner.spawn({ prompt: "x", model: "m", systemPrompt: "be concise" });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]).toEqual({ role: "system", content: "be concise" });
  });
});

describe("P1-3: tool registry filtered by args.tools allowlist", () => {
  it("throws ToolNotFoundError when model calls a tool not in args.tools allowlist", async () => {
    // Registry has 3 tools: a, b, c.  spawn is called with args.tools = ["a", "b"].
    // The mock LLM response requests tool "c" — must throw ToolNotFoundError.
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
                function: { name: "c", arguments: "{}" },
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
      .mockResolvedValue(jsonResp(toolCallResponse));

    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
      tools: {
        a: { description: "tool a", parameters: {}, execute: async () => "a" },
        b: { description: "tool b", parameters: {}, execute: async () => "b" },
        c: { description: "tool c", parameters: {}, execute: async () => "c" },
      },
    });

    // Only allow tools "a" and "b" — "c" is not in the allowlist
    await expect(
      runner.spawn({ prompt: "use tool c", tools: ["a", "b"] }),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it("allows calling a tool that is in the allowlist", async () => {
    // Registry has a, b, c. spawn with args.tools = ["a"]. Model calls "a" — ok.
    const toolCallThenStop: ChatCompletionResponse[] = [
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call1",
                  type: "function",
                  function: { name: "a", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      },
      {
        choices: [
          {
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    ];

    let callIdx = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      const resp = toolCallThenStop[callIdx++];
      return Promise.resolve(jsonResp(resp));
    });

    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
      tools: {
        a: {
          description: "tool a",
          parameters: {},
          execute: async () => "result-a",
        },
        b: { description: "tool b", parameters: {}, execute: async () => "b" },
        c: { description: "tool c", parameters: {}, execute: async () => "c" },
      },
    });

    const result = await runner.spawn({ prompt: "use a", tools: ["a"] });
    expect(result.stdout).toBe("done");
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]?.name).toBe("a");
  });
});

describe("ApiRunner.validate", () => {
  it("returns ok + version from the first model id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await runner.validate();
    expect(res.ok).toBe(true);
    expect(res.version).toBe("gpt-4o");
  });

  it("returns { ok: false } on 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("unauthorized", {
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "bad",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await runner.validate();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("401");
  });

  it("returns { ok: false } when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const runner = new ApiRunner({
      baseUrl: "http://localhost:1",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await runner.validate();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("trailing slash on baseUrl is normalized", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "m" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1/",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await runner.validate();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://example.test/v1/models");
  });
});
