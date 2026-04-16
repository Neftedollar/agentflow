import { describe, expect, it, vi } from "vitest";
import { ApiRunner } from "../api-runner.js";
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
