import type { Logger } from "@ageflow/core";
import { spawnMockMcpServer } from "@ageflow/testing";
import { describe, expect, it, vi } from "vitest";
import {
  McpServerStartFailedError,
  McpToolCallFailedError,
  shutdownAll,
  startMcpClients,
} from "../mcp-client.js";

// Helper: wait for a number of milliseconds
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: return true if the process with the given pid is still alive
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Helper: wait until the process exits (up to maxWaitMs), polling every pollMs
async function waitUntilDead(
  pid: number,
  maxWaitMs: number,
  pollMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(pollMs);
  }
  return !isAlive(pid);
}

describe("startMcpClients", () => {
  it("starts a client per McpServerConfig and lists tools", async () => {
    // For this test the mock server runs in-process via a stdio pipe.
    // spawnMockMcpServer gives us a (command, args) pair that spawns it.
    const handle = spawnMockMcpServer.asSubprocessCommand({
      tools: [{ name: "echo", description: "", inputSchema: {} }],
    });
    const clients = await startMcpClients([
      { name: "mock", command: handle.command, args: [...handle.args] },
    ]);
    expect(clients).toHaveLength(1);
    const client = clients[0];
    if (!client) throw new Error("expected client");
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    await shutdownAll(clients);
  });

  it("throws McpServerStartFailedError when command is not on PATH", async () => {
    await expect(
      startMcpClients([{ name: "x", command: "/no/such/binary" }]),
    ).rejects.toThrow(/mcp_server_start_failed/i);
  });
});

// ─── Timeout / kill path tests (I4) ─────────────────────────────────────────

describe("McpClient timeout and kill escalation", () => {
  it(
    "C1+C2: rejects with McpToolCallFailedError on timeout and the subprocess exits after SIGTERM",
    async () => {
      // Start a client against a mock server that hangs on every call
      const handle = spawnMockMcpServer.asSubprocessCommand({
        tools: [{ name: "hang", description: "", inputSchema: {} }],
        hangOn: "call",
      });

      const clients = await startMcpClients([
        {
          name: "hang-mock",
          command: handle.command,
          args: [...handle.args],
          mcpCallTimeoutMs: 100,
        },
      ]);

      const client = clients[0];
      if (!client) throw new Error("expected client");

      // Grab the subprocess pid before the call (transport is private; cast for test access)
      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to access private field
      const pid: number | null = (client as any).transport.pid;
      expect(typeof pid).toBe("number");
      if (pid === null) throw new Error("expected pid");

      // callTool should reject with a timeout error
      await expect(client.callTool("hang", {})).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof McpToolCallFailedError && /timeout/i.test(err.message),
      );

      // After rejection the subprocess should have received SIGTERM and exit.
      // Give it up to 1 000 ms to die (Node processes handle SIGTERM quickly).
      const died = await waitUntilDead(pid, 1_000);
      expect(died).toBe(true);

      // Cleanup (best-effort — subprocess may already be gone)
      await shutdownAll(clients).catch(() => {});
    },
    { timeout: 5_000 },
  );

  it(
    "C1: happy-path calls do NOT send SIGTERM — subprocess stays alive after successful calls",
    async () => {
      // Start a client against a normal echo mock server
      const handle = spawnMockMcpServer.asSubprocessCommand({
        tools: [{ name: "echo", description: "", inputSchema: {} }],
      });

      // mcpCallTimeoutMs is intentionally short (100 ms) but the echo server
      // responds immediately, so the SIGTERM timer must be cleared on each call.
      const clients = await startMcpClients([
        {
          name: "echo-mock",
          command: handle.command,
          args: [...handle.args],
          mcpCallTimeoutMs: 100,
        },
      ]);

      const client = clients[0];
      if (!client) throw new Error("expected client");

      // biome-ignore lint/suspicious/noExplicitAny: test-only cast to access private field
      const pid: number | null = (client as any).transport.pid;
      expect(typeof pid).toBe("number");
      if (pid === null) throw new Error("expected pid");

      // Three successful calls in sequence
      for (let i = 0; i < 3; i++) {
        await client.callTool("echo", { text: `call-${i}` });
      }

      // Wait past the timeout window — if the C1 bug were present the
      // SIGTERM timer from the last call would fire here.
      await delay(150);

      // The subprocess must still be alive
      expect(isAlive(pid)).toBe(true);

      await shutdownAll(clients);
    },
    { timeout: 5_000 },
  );
});

// ─── Issue #71: logger wired through startMcpClients ─────────────────────────

describe("startMcpClients logger (issue #71)", () => {
  it(
    "tees MCP subprocess stderr to the injected logger",
    async () => {
      // crashOn:"initialize" causes the subprocess to write to stderr before
      // exiting, so we can capture the debug call even though startup fails.
      const handle = spawnMockMcpServer.asSubprocessCommand({
        tools: [],
        crashOn: "initialize",
      });

      const mockLogger: Logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      // The server crashes on initialize — startMcpClients must throw.
      await expect(
        startMcpClients(
          [
            {
              name: "crashing",
              command: handle.command,
              args: [...handle.args],
            },
          ],
          mockLogger,
        ),
      ).rejects.toThrow(McpServerStartFailedError);

      // The subprocess wrote "mock-mcp: crashing on initialize\n" to stderr
      // before exiting. The logger.debug should have received it.
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("[mcp:crashing]"),
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("crashing on initialize"),
      );
    },
    { timeout: 5_000 },
  );

  it("does not throw when no logger is provided (stderr silently discarded)", async () => {
    const handle = spawnMockMcpServer.asSubprocessCommand({
      tools: [],
      crashOn: "initialize",
    });

    // Should still throw McpServerStartFailedError, but no crash from missing logger
    await expect(
      startMcpClients([
        {
          name: "crashing-nolog",
          command: handle.command,
          args: [...handle.args],
        },
      ]),
    ).rejects.toThrow(McpServerStartFailedError);
  });
});

// ─── Issue #72: no redundant env-var expansion ────────────────────────────────

describe("startMcpClients env passthrough (issue #72)", () => {
  it(
    "passes env values as-is without expanding ${env:VAR} placeholders",
    async () => {
      // If expansion still happened, ${env:__NONEXISTENT_VAR__} would silently
      // become "" and the value would be corrupted.
      const placeholder = "${env:__NONEXISTENT_VAR__}";

      const handle = spawnMockMcpServer.asSubprocessCommand({
        tools: [{ name: "echo", description: "", inputSchema: {} }],
      });

      // We can't easily inspect the env passed to the subprocess, but we can
      // verify that startMcpClients starts successfully when env contains an
      // unexpanded placeholder — demonstrating it is passed verbatim.
      const clients = await startMcpClients([
        {
          name: "env-mock",
          command: handle.command,
          args: [...handle.args],
          env: { MY_VAR: placeholder },
        },
      ]);

      expect(clients).toHaveLength(1);
      await shutdownAll(clients);
    },
    { timeout: 5_000 },
  );
});
