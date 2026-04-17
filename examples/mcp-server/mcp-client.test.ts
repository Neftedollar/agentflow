/**
 * mcp-client-test.ts — MCP SDK InMemoryTransport integration test.
 *
 * Uses @modelcontextprotocol/sdk's InMemoryTransport + Client to verify:
 *   1. Client can list the workflow tool via tools/list
 *   2. Client can call the tool and receive a greeting via tools/call
 *   3. Invalid input returns isError: true
 *   4. Async mode: start_greet → poll get_workflow_status → get_workflow_result
 *
 * No real Claude calls are made — the executor is replaced with a minimal
 * mock via the runWorkflow injection point on createMcpServer, or via the
 * _testRunExecutor hook for async-mode tests.
 */

import { createSingleWorkflowServer } from "@ageflow/mcp-server";
import type { McpServerHandle, RunWorkflowFn } from "@ageflow/mcp-server";
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wire a McpServerHandle to an InMemoryTransport and return a connected Client.
 * The caller owns `handle.dispose()` and `client.close()`.
 */
async function buildClient(
  handle: McpServerHandle,
  serverName = "greet-server",
  stderrSink?: (line: string) => void,
): Promise<Client> {
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();

  const { startStdioTransport } = await import("@ageflow/mcp-server");

  await startStdioTransport({
    serverName,
    serverVersion: "0.1.0",
    handle,
    transport: serverTransport,
    stderr: stderrSink ?? (() => {}),
  });

  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

/** Resolve once `get_workflow_status` reports state === targetState. */
async function pollUntil(
  client: Client,
  jobId: string,
  targetState: string,
  maxAttempts = 50,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await client.callTool({
      name: "get_workflow_status",
      arguments: { jobId },
    });
    if (res.isError)
      throw new Error(`get_workflow_status error on attempt ${i}`);
    const text =
      (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
    const status = JSON.parse(text) as { state: string };
    if (status.state === targetState) return status as Record<string, unknown>;
    // Yield the event loop so the background fire() async-gen can advance.
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  throw new Error(
    `pollUntil("${targetState}") timed out after ${maxAttempts} attempts`,
  );
}

// ─── Sync test suite ──────────────────────────────────────────────────────────

describe("mcp-server example — InMemoryTransport client test", () => {
  let client: Client;
  let stderrLines: string[];

  beforeEach(async () => {
    stderrLines = [];

    const handle = createSingleWorkflowServer({
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

// ─── Async mode test suite ────────────────────────────────────────────────────

describe("mcp-server example — async mode via InMemoryTransport", () => {
  /**
   * Scenario: start the server with --async --hitl auto, verify 6 tools are
   * exposed, fire start_greet, poll get_workflow_status until done, fetch the
   * final result via get_workflow_result, and assert the greeting output.
   *
   * The runner is mocked via `handle._testRunExecutor` (same approach used by
   * the async-mode integration tests in @ageflow/mcp-server), which bypasses
   * the real Claude CLI subprocess — no subprocess is spawned.
   *
   * The async dispatchStart path now injects the runtime MCP call arguments
   * into the input task's `input` field before calling runner.fire() — the same
   * way the sync path does via makeDefaultRunner. No static-input workaround is
   * needed here; the base `workflow` (with no pre-set task input) works directly.
   */
  it("start_greet → poll until done → get_workflow_result returns greeting", async () => {
    // Build the server handle in async mode (--async --hitl auto equivalent).
    // Use the base workflow directly — no static-input shim needed since
    // dispatchStart now injects runtime args before firing (fix for #84 item 10).
    const handle = createSingleWorkflowServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
    });

    // Inject a mock executor: receives the runtime input ({ name: "Bob" })
    // injected by dispatchStart and returns a greeting without spawning a real
    // Claude subprocess.
    handle._testRunExecutor = async (args) => {
      const input = args as { name: string };
      return { greeting: `Hello, ${input.name}!` };
    };

    const client = await buildClient(handle, "greet-async-server");

    try {
      // 1. List tools — expect 6 (sync greet + 5 async job tools).
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "cancel_workflow",
          "get_workflow_result",
          "get_workflow_status",
          "greet",
          "resume_workflow",
          "start_greet",
        ].sort(),
      );

      // 2. Call start_greet → get jobId.
      const startRes = await client.callTool({
        name: "start_greet",
        arguments: { name: "Bob" },
      });
      expect(startRes.isError).toBeFalsy();
      const startText =
        (startRes.content as { type: string; text: string }[])[0]?.text ?? "{}";
      const { jobId } = JSON.parse(startText) as { jobId: string };
      expect(typeof jobId).toBe("string");
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

      // 3. Poll get_workflow_status until state === "done".
      await pollUntil(client, jobId, "done");

      // 4. Fetch the result and assert the greeting.
      const resultRes = await client.callTool({
        name: "get_workflow_result",
        arguments: { jobId },
      });
      expect(resultRes.isError).toBeFalsy();
      const resultText =
        (resultRes.content as { type: string; text: string }[])[0]?.text ??
        "{}";
      const result = JSON.parse(resultText) as {
        state: string;
        output: { greeting: string };
      };
      expect(result.state).toBe("done");
      expect(result.output.greeting).toBe("Hello, Bob!");
    } finally {
      await client.close();
      handle.dispose?.();
    }
  }, 10_000); // 10 s timeout — polling loop needs multiple event-loop ticks
});
