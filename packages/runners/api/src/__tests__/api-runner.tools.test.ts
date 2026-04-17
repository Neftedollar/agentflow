/**
 * api-runner.tools.test.ts
 *
 * Tests for the 3-way inline tool merge precedence in ApiRunner.spawn():
 *   instance (constructor) < agent (AgentDef inline map) < per-call (inlineTools arg)
 *
 * Also verifies that InlineToolDef.execute is called with Zod-validated args,
 * and that validation errors surface cleanly.
 */

import type { InlineToolDef } from "@ageflow/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiRunner } from "../api-runner.js";
import {
  inlineToolDefToToolDefinition,
  inlineToolsToRegistry,
  mergeInlineTools,
} from "../inline-tools.js";
import type { ChatCompletionResponse } from "../openai-types.js";
import type { ToolRegistry } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function terminalResp(content = "done"): ChatCompletionResponse {
  return {
    choices: [
      {
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  };
}

function toolCallResp(
  toolName: string,
  callArgs: Record<string, unknown>,
): ChatCompletionResponse {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(callArgs),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeInlineTool<I, O>(
  description: string,
  schema: z.ZodType<I>,
  executeFn: (args: I) => Promise<O>,
): InlineToolDef<I, O> {
  return { description, parameters: schema, execute: executeFn };
}

// ─── Unit: inlineToolDefToToolDefinition ─────────────────────────────────────

describe("inlineToolDefToToolDefinition", () => {
  it("produces a ToolDefinition with correct description", () => {
    const def = makeInlineTool(
      "add two numbers",
      z.object({ a: z.number(), b: z.number() }),
      async ({ a, b }) => a + b,
    );
    const td = inlineToolDefToToolDefinition(def);
    expect(td.description).toBe("add two numbers");
  });

  it("generates a JSON schema from the Zod parameters", () => {
    const def = makeInlineTool(
      "greet",
      z.object({ name: z.string() }),
      async ({ name }) => `Hello, ${name}`,
    );
    const td = inlineToolDefToToolDefinition(def);
    // zod-to-json-schema produces type: "object" with a properties map
    expect(td.parameters).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
  });

  it("calls execute with Zod-validated typed args", async () => {
    const executeFn = vi.fn(async ({ x }: { x: number }) => x * 2);
    const def = makeInlineTool(
      "double",
      z.object({ x: z.number() }),
      executeFn,
    );
    const td = inlineToolDefToToolDefinition(def);

    const result = await td.execute({ x: 5 });
    expect(result).toBe(10);
    expect(executeFn).toHaveBeenCalledWith({ x: 5 });
  });

  it("throws on invalid args (Zod validation failure)", async () => {
    const def = makeInlineTool(
      "strict",
      z.object({ n: z.number() }),
      async ({ n }) => n,
    );
    const td = inlineToolDefToToolDefinition(def);

    await expect(td.execute({ n: "not-a-number" })).rejects.toThrow(
      "Inline tool argument validation failed",
    );
  });

  it("coerces/transforms via Zod schema before execute", async () => {
    const executeFn = vi.fn(async (args: { ts: Date }) =>
      args.ts.toISOString(),
    );
    const def = makeInlineTool(
      "with-coerce",
      z.object({ ts: z.coerce.date() }),
      executeFn,
    );
    const td = inlineToolDefToToolDefinition(def);

    await td.execute({ ts: "2024-01-01" });
    // execute should receive a real Date, not a string
    const received = executeFn.mock.calls[0]?.[0]?.ts;
    expect(received).toBeInstanceOf(Date);
  });
});

// ─── Unit: mergeInlineTools ───────────────────────────────────────────────────

describe("mergeInlineTools — 3-way precedence", () => {
  const instanceRegistry: ToolRegistry = {
    instance_tool: {
      description: "instance",
      parameters: {},
      execute: async () => "instance",
    },
  };

  const agentMap: Record<string, InlineToolDef> = {
    agent_tool: makeInlineTool("agent", z.object({}), async () => "agent"),
    shared_tool: makeInlineTool(
      "agent-version",
      z.object({}),
      async () => "agent-version",
    ),
  };

  const perCallMap: Record<string, InlineToolDef> = {
    percall_tool: makeInlineTool(
      "per-call",
      z.object({}),
      async () => "per-call",
    ),
    shared_tool: makeInlineTool(
      "percall-version",
      z.object({}),
      async () => "percall-version",
    ),
  };

  it("includes instance tools when no other layers provided", () => {
    const merged = mergeInlineTools(instanceRegistry, undefined, undefined);
    expect(Object.keys(merged)).toContain("instance_tool");
  });

  it("adds agent-level inline tools on top of instance tools", () => {
    const merged = mergeInlineTools(instanceRegistry, agentMap, undefined);
    expect(Object.keys(merged)).toContain("instance_tool");
    expect(Object.keys(merged)).toContain("agent_tool");
  });

  it("adds per-call inline tools on top of agent + instance tools", () => {
    const merged = mergeInlineTools(instanceRegistry, agentMap, perCallMap);
    expect(Object.keys(merged)).toContain("instance_tool");
    expect(Object.keys(merged)).toContain("agent_tool");
    expect(Object.keys(merged)).toContain("percall_tool");
  });

  it("per-call overrides agent-level for same tool name (later wins)", async () => {
    const merged = mergeInlineTools(instanceRegistry, agentMap, perCallMap);
    // shared_tool should be the per-call version
    const result = await merged.shared_tool?.execute({});
    expect(result).toBe("percall-version");
  });

  it("agent-level overrides instance for same tool name", async () => {
    const instanceWithShared: ToolRegistry = {
      ...instanceRegistry,
      shared_tool: {
        description: "instance-version",
        parameters: {},
        execute: async () => "instance-version",
      },
    };
    const merged = mergeInlineTools(instanceWithShared, agentMap, undefined);
    // shared_tool in agentMap should win over instance
    const result = await merged.shared_tool?.execute({});
    expect(result).toBe("agent-version");
  });

  it("does not mutate the instanceTools registry passed in", () => {
    const frozen = { ...instanceRegistry };
    mergeInlineTools(frozen, agentMap, perCallMap);
    // Original should still have only instance_tool
    expect(Object.keys(frozen)).toEqual(["instance_tool"]);
  });
});

// ─── Unit: inlineToolsToRegistry ─────────────────────────────────────────────

describe("inlineToolsToRegistry", () => {
  it("converts every entry in the map to a ToolDefinition", () => {
    const defs: Record<string, InlineToolDef> = {
      foo: makeInlineTool(
        "foo-desc",
        z.object({ v: z.string() }),
        async ({ v }) => v,
      ),
      bar: makeInlineTool(
        "bar-desc",
        z.object({ n: z.number() }),
        async ({ n }) => n,
      ),
    };
    const registry = inlineToolsToRegistry(defs);
    expect(Object.keys(registry).sort()).toEqual(["bar", "foo"]);
    expect(registry.foo?.description).toBe("foo-desc");
    expect(registry.bar?.description).toBe("bar-desc");
  });
});

// ─── Integration: ApiRunner.spawn with inlineTools ───────────────────────────

describe("ApiRunner.spawn — inline tools via inlineTools arg", () => {
  it("executes an inline tool when the model calls it", async () => {
    const echoExecute = vi.fn(
      async ({ msg }: { msg: string }) => `echo:${msg}`,
    );

    // First response: model calls the inline tool
    // Second response: terminal
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResp(toolCallResp("echo_tool", { msg: "hello" })),
      )
      .mockResolvedValueOnce(jsonResp(terminalResp("got echo:hello")));

    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({
      prompt: "use the echo tool",
      model: "gpt-4o",
      inlineTools: {
        echo_tool: makeInlineTool(
          "echo a message",
          z.object({ msg: z.string() }),
          echoExecute,
        ),
      },
      tools: ["echo_tool"],
    });

    expect(res.stdout).toBe("got echo:hello");
    expect(echoExecute).toHaveBeenCalledWith({ msg: "hello" });
    // Two API calls: tool_calls round + terminal round
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("per-call inline tool overrides instance tool with same name", async () => {
    const instanceExecute = vi.fn(async () => "from-instance");
    const perCallExecute = vi.fn(async () => "from-per-call");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResp(toolCallResp("shared_tool", {})))
      .mockResolvedValueOnce(jsonResp(terminalResp("ok")));

    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
      tools: {
        shared_tool: {
          description: "instance version",
          parameters: {},
          execute: instanceExecute,
        },
      },
    });

    await runner.spawn({
      prompt: "use tool",
      model: "gpt-4o",
      inlineTools: {
        shared_tool: makeInlineTool(
          "per-call version",
          z.object({}),
          perCallExecute,
        ),
      },
      tools: ["shared_tool"],
    });

    // The per-call version should have been called, not the instance version
    expect(perCallExecute).toHaveBeenCalledTimes(1);
    expect(instanceExecute).not.toHaveBeenCalled();
  });

  it("inline tool with invalid args returns error message to model (does not throw)", async () => {
    // When an inline tool's Zod validation fails, it should send an error back
    // to the model rather than crashing the runner.
    const fetchMock = vi
      .fn()
      // model calls tool with wrong arg type
      .mockResolvedValueOnce(
        jsonResp(toolCallResp("strict_tool", { n: "not-a-number" })),
      )
      // model responds after seeing the error
      .mockResolvedValueOnce(jsonResp(terminalResp("I got an error")));

    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({
      prompt: "use strict tool",
      model: "gpt-4o",
      inlineTools: {
        strict_tool: makeInlineTool(
          "needs a number",
          z.object({ n: z.number() }),
          async ({ n }) => n,
        ),
      },
      tools: ["strict_tool"],
    });

    // Runner completes; model got the error as a tool result
    expect(res.stdout).toBe("I got an error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("spawn with no inlineTools still works (regression guard)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResp(terminalResp("no tools needed")));

    const runner = new ApiRunner({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      defaultModel: "gpt-4o",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await runner.spawn({ prompt: "hello" });
    expect(res.stdout).toBe("no tools needed");
  });
});
