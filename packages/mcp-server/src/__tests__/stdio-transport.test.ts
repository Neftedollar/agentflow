/**
 * stdio-transport.test.ts
 *
 * Verifies that startStdioTransport wires the SDK Server correctly by using
 * InMemoryTransport + Client (no real stdio involved).
 */

import { defineAgent, defineWorkflow } from "@ageflow/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RunWorkflowFn } from "../server.js";
import { createMcpServer } from "../server.js";
import { startStdioTransport } from "../stdio-transport.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const greetAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  prompt: ({ name }) => `say hi to ${name}`,
});

const workflow = defineWorkflow({
  name: "greet",
  mcp: { description: "Greet someone", maxCostUsd: 0.5 },
  tasks: { greet: { agent: greetAgent } },
});

/** Minimal runWorkflow that immediately returns a greeting. */
const mockRunWorkflow: RunWorkflowFn = async (args) => {
  const input = args.input as { name: string };
  return { greeting: `hello, ${input.name}!` };
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("startStdioTransport (InMemoryTransport)", () => {
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

    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    // Start transport (server side)
    await startStdioTransport({
      serverName: "test-server",
      serverVersion: "0.0.1",
      handle,
      transport: serverTransport,
      stderr: (line) => {
        stderrLines.push(line);
      },
    });

    // Connect client side
    client = new Client(
      { name: "test-client", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  it("emits startup banner to stderr", () => {
    expect(stderrLines.join("")).toMatch(/ageflow mcp.*test-server.*0\.0\.1/);
  });

  it("tools/list returns the workflow tool", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("greet");
    expect(tools[0]?.description).toBe("Greet someone");
  });

  it("tools/call returns the greeting", async () => {
    const result = await client.callTool({
      name: "greet",
      arguments: { name: "World" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    const parsed = JSON.parse(text ?? "{}") as { greeting: string };
    expect(parsed.greeting).toBe("hello, World!");
  });

  it("tools/call with invalid input returns isError: true", async () => {
    const result = await client.callTool({
      name: "greet",
      arguments: { name: 123 }, // invalid — name must be string
    });
    expect(result.isError).toBe(true);
    // The error message in content text references the validation failure
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toMatch(/schema validation failed/i);
  });

  it("tools/call unknown tool returns isError: true", async () => {
    const result = await client.callTool({
      name: "nonexistent",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });
});
