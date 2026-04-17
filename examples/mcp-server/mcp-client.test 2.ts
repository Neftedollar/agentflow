/**
 * mcp-client-test.ts — MCP SDK InMemoryTransport integration test.
 *
 * Uses @modelcontextprotocol/sdk's InMemoryTransport + Client to verify:
 *   1. Client can list the workflow tool via tools/list
 *   2. Client can call the tool and receive a greeting via tools/call
 *   3. Invalid input returns isError: true
 *
 * No real Claude calls are made — the executor is replaced with a minimal
 * mock via the runWorkflow injection point on createMcpServer.
 */

import { createMcpServer } from "@ageflow/mcp-server";
import type { RunWorkflowFn } from "@ageflow/mcp-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import workflow from "./workflow.js";

// ─── Mock RunWorkflowFn ───────────────────────────────────────────────────────

/**
 * Mock executor: returns a greeting without calling Claude.
 * The input arrives as the validated input object from the boundary task.
 */
const mockRunWorkflow: RunWorkflowFn = async (args) => {
  const input = args.input as { name: string };
  return { greeting: `Hello, ${input.name}!` };
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("mcp-server example — InMemoryTransport client test", () => {
  let client: Client;
  let stderrLines: string[];

  beforeEach(async () => {
    stderrLines = [];

    const handle = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "fail",
      runWorkflow: mockRunWorkflow,
    });

    // Create linked in-memory transports: one for the server, one for the client.
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    // Dynamic import so we don't pull in the SDK server at the module level.
    const { startStdioTransport } = await import("@ageflow/mcp-server");

    await startStdioTransport({
      serverName: "greet-server",
      serverVersion: "0.1.0",
      handle,
      transport: serverTransport,
      stderr: (line) => stderrLines.push(line),
    });

    client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  it("prints startup banner to stderr", () => {
    expect(stderrLines.join("")).toMatch(/ageflow mcp.*greet-server/);
  });

  it("lists the greet tool", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("greet");
    expect(tools[0]?.description).toMatch(/Greet a person/i);
  });

  it("tools/call returns a greeting", async () => {
    const result = await client.callTool({
      name: "greet",
      arguments: { name: "Alice" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    const parsed = JSON.parse(text ?? "{}") as { greeting: string };
    expect(parsed.greeting).toBe("Hello, Alice!");
  });

  it("tools/call with invalid input returns isError: true", async () => {
    const result = await client.callTool({
      name: "greet",
      arguments: { name: 42 }, // name must be string
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toMatch(/schema validation failed/i);
  });
});
