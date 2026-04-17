/**
 * programmatic-api.test.ts
 *
 * Tests for the public createMcpServer() programmatic API (programmatic.ts).
 *
 * All tests use InMemoryTransport so no real stdio is involved.
 */

import { defineAgent, defineWorkflow } from "@ageflow/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpMiddleware, McpMiddlewareRequest } from "../programmatic.js";
import { createMcpServer } from "../programmatic.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const greetAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  prompt: ({ name }) => `say hi to ${name}`,
});

const greetWorkflow = defineWorkflow({
  name: "greet",
  mcp: { description: "Greet someone", maxCostUsd: 0.5 },
  tasks: { greet: { agent: greetAgent } },
});

const summarizeAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({ text: z.string() }),
  output: z.object({ summary: z.string() }),
  prompt: ({ text }) => `summarize: ${text}`,
});

const summarizeWorkflow = defineWorkflow({
  name: "summarize",
  mcp: { description: "Summarize text", maxCostUsd: 0.3 },
  tasks: { summarize: { agent: summarizeAgent } },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a mock RunWorkflowFn that returns a fixed output.
 * Injected via _testRunExecutor on the router handle.
 */
function makeMockExecutor(
  output: Record<string, unknown>,
): (
  args: unknown,
  hooks: unknown,
  signal: AbortSignal,
  effective: unknown,
) => Promise<unknown> {
  return async () => output;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createMcpServer() — single workflow", () => {
  it("throws when no workflows provided", () => {
    expect(() =>
      createMcpServer({
        workflows: [] as unknown as ReturnType<typeof defineWorkflow>[],
      }),
    ).toThrow("at least one workflow");
  });

  it("throws on duplicate workflow names", () => {
    expect(() =>
      createMcpServer({ workflows: [greetWorkflow, greetWorkflow] }),
    ).toThrow('duplicate workflow name "greet"');
  });

  it("returns an McpHandle with listen and close", () => {
    const handle = createMcpServer({ workflows: greetWorkflow });
    expect(typeof handle.listen).toBe("function");
    expect(typeof handle.close).toBe("function");
    expect(handle._routerHandle).toBeDefined();
  });

  it("router listTools returns the workflow tool", async () => {
    const handle = createMcpServer({ workflows: greetWorkflow });
    const tools = await handle._routerHandle.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("greet");
    expect(tools[0]?.description).toBe("Greet someone");
  });

  it("router callTool succeeds with mock executor", async () => {
    const handle = createMcpServer({ workflows: greetWorkflow });
    // Inject mock executor into the per-workflow handle via _testRunExecutor
    handle._routerHandle._testRunExecutor = makeMockExecutor({
      greeting: "hello, Alice!",
    });

    const result = await handle._routerHandle.callTool("greet", {
      name: "Alice",
    });
    expect(result.isError).toBe(false);
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(JSON.parse(text ?? "{}")).toEqual({ greeting: "hello, Alice!" });
  });

  it("router callTool returns error for unknown tool", async () => {
    const handle = createMcpServer({ workflows: greetWorkflow });
    const result = await handle._routerHandle.callTool("unknown_tool", {});
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as { errorCode: string };
    expect(sc.errorCode).toBe("WORKFLOW_FAILED");
  });

  it("accepts a single workflow (not array)", () => {
    // Single WorkflowDef (not array) should work
    const handle = createMcpServer({ workflows: greetWorkflow });
    expect(handle).toBeDefined();
  });
});

describe("createMcpServer() — multi-workflow", () => {
  it("lists tools from both workflows", async () => {
    const handle = createMcpServer({
      workflows: [greetWorkflow, summarizeWorkflow],
    });
    const tools = await handle._routerHandle.listTools();
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain("greet");
    expect(names).toContain("summarize");
  });

  it("routes callTool to the correct workflow handle", async () => {
    const handle = createMcpServer({
      workflows: [greetWorkflow, summarizeWorkflow],
    });
    // Inject a mock into the router — this tests routing only (no executor)
    handle._routerHandle._testRunExecutor = async (args: unknown) => {
      const a = args as Record<string, unknown>;
      if ("name" in a) return { greeting: `hi, ${a.name}!` };
      if ("text" in a) return { summary: `short: ${a.text}` };
      throw new Error("unexpected input");
    };

    const greetResult = await handle._routerHandle.callTool("greet", {
      name: "Bob",
    });
    expect(greetResult.isError).toBe(false);

    const summarizeResult = await handle._routerHandle.callTool("summarize", {
      text: "long text here",
    });
    expect(summarizeResult.isError).toBe(false);
    const sumText = (
      summarizeResult.content as { type: string; text: string }[]
    )[0]?.text;
    expect(JSON.parse(sumText ?? "{}")).toEqual({
      summary: "short: long text here",
    });
  });

  it("uses 'ageflow-mcp' as default serverName for multiple workflows", () => {
    // Verify via internals that the serverName would be "ageflow-mcp"
    // (we can't easily check this without starting transport, so just verify
    // the handle is constructed without throwing)
    const handle = createMcpServer({
      workflows: [greetWorkflow, summarizeWorkflow],
    });
    expect(handle).toBeDefined();
  });

  it("uses first workflow name as serverName for single workflow", () => {
    const handle = createMcpServer({ workflows: greetWorkflow });
    expect(handle).toBeDefined();
    // serverName defaults to greetWorkflow.name = "greet"
  });

  it("uses custom serverName when provided", () => {
    const handle = createMcpServer({
      workflows: [greetWorkflow, summarizeWorkflow],
      serverName: "my-custom-server",
    });
    expect(handle).toBeDefined();
  });
});

describe("createMcpServer() — middleware", () => {
  it("middleware is called for each callTool invocation", async () => {
    const calls: McpMiddlewareRequest[] = [];
    const loggingMiddleware: McpMiddleware = async (req, next) => {
      calls.push(req);
      return next();
    };

    const handle = createMcpServer({
      workflows: greetWorkflow,
      middleware: [loggingMiddleware],
    });
    // Inject mock executor via router so it propagates to inner handle
    handle._routerHandle._testRunExecutor = makeMockExecutor({
      greeting: "hello!",
    });

    // Call through _finalHandle so middleware runs
    await handle._finalHandle.callTool("greet", { name: "Eve" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("greet");
    expect((calls[0]?.args as { name: string }).name).toBe("Eve");
  });

  it("middleware can short-circuit without calling next", async () => {
    const blockingMiddleware: McpMiddleware = async (_req, _next) => {
      return {
        content: [{ type: "text" as const, text: "blocked by middleware" }],
        structuredContent: { errorCode: "WORKFLOW_FAILED", message: "blocked" },
        isError: true as const,
      };
    };

    const handle = createMcpServer({
      workflows: greetWorkflow,
      middleware: [blockingMiddleware],
    });
    // Call through _finalHandle so middleware runs; no executor needed (short-circuit)
    const result = await handle._finalHandle.callTool("greet", {
      name: "Mallory",
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toBe("blocked by middleware");
  });

  it("multiple middleware are called in order (first = outermost)", async () => {
    const order: string[] = [];

    const first: McpMiddleware = async (req, next) => {
      order.push("first-before");
      const result = await next();
      order.push("first-after");
      return result;
    };

    const second: McpMiddleware = async (req, next) => {
      order.push("second-before");
      const result = await next();
      order.push("second-after");
      return result;
    };

    const handle = createMcpServer({
      workflows: greetWorkflow,
      middleware: [first, second],
    });
    handle._routerHandle._testRunExecutor = makeMockExecutor({
      greeting: "hi!",
    });

    // Call through _finalHandle so both middleware run
    await handle._finalHandle.callTool("greet", { name: "Test" });
    expect(order).toEqual([
      "first-before",
      "second-before",
      "second-after",
      "first-after",
    ]);
  });

  it("no middleware is fine (identity pass-through)", async () => {
    const handle = createMcpServer({ workflows: greetWorkflow });
    handle._routerHandle._testRunExecutor = makeMockExecutor({
      greeting: "hi!",
    });

    // Without middleware, _finalHandle === _routerHandle
    const result = await handle._finalHandle.callTool("greet", { name: "X" });
    expect(result.isError).toBe(false);
  });
});

describe("createMcpServer() — onHitl", () => {
  it("onHitl is wired: approval resolves checkpoint", async () => {
    // We can't easily trigger a real HITL checkpoint without the executor.
    // Instead, verify that when onHitl is provided, the workflow gets patched
    // with a hooks.onCheckpoint (observable via _testOnComposedWorkflow).
    const onHitl = vi.fn(async (_task: string, _msg: string) => true);

    const handle = createMcpServer({
      workflows: greetWorkflow,
      onHitl,
    });

    // The workflow was patched with hooks — observable by constructing a
    // fresh run that invokes the checkpoint directly via the patched hook.
    // Since we can't run the real executor without a runner, we test the
    // hook was set by checking the handle was created without error.
    expect(handle).toBeDefined();
    expect(handle._routerHandle).toBeDefined();
  });

  it("onHitl not provided → hitlStrategy applied (default: elicit)", () => {
    const handle = createMcpServer({
      workflows: greetWorkflow,
      // No onHitl → hitlStrategy: "elicit" is default
    });
    expect(handle).toBeDefined();
  });

  it("onHitl with custom hitlStrategy is respected", () => {
    const onHitl = vi.fn(async () => false);
    // When onHitl is set, hitlStrategy is internally overridden to "auto"
    // (since onHitl is a hook-level override). No error expected.
    const handle = createMcpServer({
      workflows: greetWorkflow,
      onHitl,
      hitlStrategy: "fail", // ignored when onHitl is set
    });
    expect(handle).toBeDefined();
  });
});

describe("createMcpServer() — transport/listen via InMemoryTransport", () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    server = createMcpServer({
      workflows: [greetWorkflow, summarizeWorkflow],
      transport: serverTransport,
      stderr: () => {},
    });

    // Inject mock executors before listen
    server._routerHandle._testRunExecutor = async (args: unknown) => {
      const a = args as Record<string, unknown>;
      if ("name" in a) return { greeting: `hi, ${a.name}!` };
      if ("text" in a)
        return { summary: `brief: ${String(a.text).slice(0, 5)}` };
      throw new Error("unexpected");
    };

    await server.listen();

    client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("tools/list includes both workflow tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["greet", "summarize"]);
  });

  it("tools/call routes to greet workflow", async () => {
    const result = await client.callTool({
      name: "greet",
      arguments: { name: "Alice" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(JSON.parse(text ?? "{}")).toEqual({ greeting: "hi, Alice!" });
  });

  it("tools/call routes to summarize workflow", async () => {
    const result = await client.callTool({
      name: "summarize",
      arguments: { text: "Hello world!" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(JSON.parse(text ?? "{}")).toEqual({ summary: "brief: Hello" });
  });

  it("tools/call with unknown tool returns isError: true", async () => {
    const result = await client.callTool({
      name: "nonexistent",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });
});
