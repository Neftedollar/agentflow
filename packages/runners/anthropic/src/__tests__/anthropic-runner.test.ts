import { describe, expect, it, vi } from "vitest";
import { AnthropicRunner } from "../anthropic-runner.js";
import type { AnthropicResponse } from "../anthropic-types.js";
import { ToolNotFoundError } from "../errors.js";
import { InMemoryAnthropicSessionStore } from "../session-store.js";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const endTurnResponse: AnthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hello world" }],
  model: "claude-3-5-sonnet-20241022",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 3 },
};

describe("AnthropicRunner.spawn", () => {
  it("performs a single completion and returns stdout + token counts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(endTurnResponse));
    const runner = new AnthropicRunner({
      apiKey: "test-key",
      defaultModel: "claude-3-5-sonnet-20241022",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({
      prompt: "say hi",
      model: "claude-3-5-sonnet-20241022",
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
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(endTurnResponse));
    const runner = new AnthropicRunner({
      apiKey: "k",
      defaultModel: "claude-3-haiku-20240307",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await runner.spawn({ prompt: "x" });
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("claude-3-haiku-20240307");
  });

  it("throws when no model configured", async () => {
    const fetchMock = vi.fn();
    const runner = new AnthropicRunner({
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(runner.spawn({ prompt: "x" })).rejects.toThrow(
      /model not set/,
    );
  });

  it("persists history to the session store under sessionHandle", async () => {
    const store = new InMemoryAnthropicSessionStore();
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(endTurnResponse));
    const runner = new AnthropicRunner({
      apiKey: "k",
      defaultModel: "claude-3-5-sonnet-20241022",
      sessionStore: store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const first = await runner.spawn({ prompt: "p1" });
    const history = await store.get(first.sessionHandle);
    expect(history?.length).toBeGreaterThanOrEqual(2); // user + assistant
  });

  it("resumes when sessionHandle is provided", async () => {
    const store = new InMemoryAnthropicSessionStore();
    await store.set("existing", [
      { role: "user", content: "earlier" },
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier reply" }],
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(endTurnResponse));
    const runner = new AnthropicRunner({
      apiKey: "k",
      defaultModel: "claude-3-5-sonnet-20241022",
      sessionStore: store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({
      prompt: "next",
      sessionHandle: "existing",
    });
    expect(res.sessionHandle).toBe("existing");

    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string }>;
    };
    // earlier user + earlier assistant + next user = 3
    expect(body.messages.length).toBe(3);
    expect(
      (body.messages[2] as { role: string; content: string }).content,
    ).toBe("next");
  });

  it("puts systemPrompt in system field, not in messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(endTurnResponse));
    const runner = new AnthropicRunner({
      apiKey: "k",
      defaultModel: "claude-3-5-sonnet-20241022",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await runner.spawn({ prompt: "hi", systemPrompt: "be concise" });
    const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe("be concise");
    const hasSystemMsg = (body.messages as Array<{ role: string }>).some(
      (m) => m.role === "system",
    );
    expect(hasSystemMsg).toBe(false);
  });

  it("filters tool registry by args.tools allowlist", async () => {
    const toolUseResponse: AnthropicResponse = {
      id: "msg_t",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_c",
          name: "c",
          input: {},
        },
      ],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
    };

    const fetchMock = vi.fn().mockResolvedValue(jsonResp(toolUseResponse));
    const runner = new AnthropicRunner({
      apiKey: "k",
      defaultModel: "claude-3-5-sonnet-20241022",
      fetch: fetchMock as unknown as typeof fetch,
      tools: {
        a: { description: "a", parameters: {}, execute: async () => "a" },
        b: { description: "b", parameters: {}, execute: async () => "b" },
        c: { description: "c", parameters: {}, execute: async () => "c" },
      },
    });

    // Only allow tools "a" and "b" — model tries to call "c" → ToolNotFoundError
    await expect(
      runner.spawn({ prompt: "use c", tools: ["a", "b"] }),
    ).rejects.toThrow(ToolNotFoundError);
  });
});

describe("AnthropicRunner.validate", () => {
  it("returns ok:true when API responds 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(endTurnResponse));
    const runner = new AnthropicRunner({
      apiKey: "k",
      defaultModel: "claude-3-5-sonnet-20241022",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await runner.validate();
    expect(res.ok).toBe(true);
    expect(res.version).toBe("claude-3-5-sonnet-20241022");
  });

  it("returns ok:false on 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("unauthorized", {
        status: 401,
        statusText: "Unauthorized",
      }),
    );
    const runner = new AnthropicRunner({
      apiKey: "bad",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await runner.validate();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("401");
  });

  it("returns ok:false when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const runner = new AnthropicRunner({
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await runner.validate();
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });
});

describe("AnthropicRunner.shutdown", () => {
  it("resolves without error when no MCP clients are pooled", async () => {
    const runner = new AnthropicRunner({ apiKey: "k" });
    await expect(runner.shutdown()).resolves.toBeUndefined();
  });
});
