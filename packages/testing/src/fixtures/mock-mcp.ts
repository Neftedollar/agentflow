/**
 * mock-mcp.ts
 *
 * Provides `spawnMockMcpServer()` — a parametrised mock MCP server for testing.
 *
 * In-process mode (default): uses InMemoryTransport to avoid subprocess overhead.
 * Subprocess mode: `spawnMockMcpServer.asSubprocessCommand(opts)` returns
 *   `{ command, args }` to start the server as a real subprocess over stdio.
 *
 * Modes:
 *   crashOn  — exits/throws at the named lifecycle point
 *   hangOn   — never responds at the named lifecycle point
 *   isErrorOn — returns isError:true for the named tool
 */

import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MockToolSpec {
  name: string;
  description?: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON schema is untyped
  inputSchema?: Record<string, any>;
}

export interface MockMcpServerOpts {
  tools: MockToolSpec[];
  crashOn?: "initialize" | "tools/list" | "call";
  hangOn?: "initialize" | "tools/list" | "call";
  /** Tool name for which callTool returns isError:true. */
  isErrorOn?: string;
}

export interface MockMcpServerHandle {
  /** List tools the server exposes. */
  listTools(): Promise<{ name: string; description?: string | undefined }[]>;
  /** Call a tool. Optionally race against a timeout. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<unknown>;
  /** Shut down the mock server. */
  stop(): Promise<void>;
}

export interface SubprocessCommand {
  command: string;
  args: string[];
}

// ─── In-process implementation ───────────────────────────────────────────────

async function buildInProcessServer(opts: MockMcpServerOpts): Promise<Server> {
  const server = new Server(
    { name: "mock-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (opts.hangOn === "tools/list") {
      await new Promise<never>(() => {});
    }
    if (opts.crashOn === "tools/list") {
      throw new Error("mock-mcp: crashing on tools/list");
    }
    return {
      tools: opts.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: {
          type: "object" as const,
          ...(t.inputSchema ?? {}),
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (opts.hangOn === "call") {
      await new Promise<never>(() => {});
    }
    if (opts.crashOn === "call") {
      throw new Error("mock-mcp: crashing on call");
    }
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (name === opts.isErrorOn) {
      return {
        content: [
          { type: "text" as const, text: `error: tool ${name} failed` },
        ],
        isError: true,
      };
    }

    const textArg = args.text;
    const text = typeof textArg === "string" ? textArg : JSON.stringify(args);
    return {
      content: [{ type: "text" as const, text }],
      isError: false,
    };
  });

  return server;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Spawn a parametrised mock MCP server in-process using InMemoryTransport.
 * Returns a handle with listTools / callTool / stop.
 */
export async function spawnMockMcpServer(
  opts: MockMcpServerOpts,
): Promise<MockMcpServerHandle> {
  // crashOn:"initialize" — fail immediately before returning a handle
  if (opts.crashOn === "initialize") {
    throw new Error("mcp_server_start_failed: mock crash on initialize");
  }

  if (opts.hangOn === "initialize") {
    // Never resolves
    return new Promise<MockMcpServerHandle>(() => {});
  }

  const server = await buildInProcessServer(opts);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  const handle: MockMcpServerHandle = {
    async listTools() {
      const res = await client.listTools();
      return res.tools;
    },

    async callTool(name, args, callOpts) {
      const timeoutMs = callOpts?.timeoutMs;
      const doCall = client.callTool({ name, arguments: args });
      const normalise = (res: Awaited<typeof doCall>): unknown => {
        // Strip isError:false so that equality checks don't need to include it.
        // isError:true is preserved for error path assertions.
        if ("isError" in res && res.isError === false) {
          const { isError: _ignored, ...rest } = res;
          return rest;
        }
        return res;
      };
      if (timeoutMs !== undefined) {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timeout: MCP tool call timed out")),
            timeoutMs,
          ),
        );
        const res = await Promise.race([doCall, timeout]);
        return normalise(res);
      }
      const res = await doCall;
      return normalise(res);
    },

    async stop() {
      await client.close();
      await server.close();
    },
  };

  return handle;
}

/**
 * Returns `{ command, args }` for spawning the mock server as a real subprocess.
 * Used by mcp-client tests that need an actual stdio subprocess.
 */
spawnMockMcpServer.asSubprocessCommand = function asSubprocessCommand(
  opts: MockMcpServerOpts,
): SubprocessCommand {
  const scriptPath = fileURLToPath(
    new URL("./mock-mcp-server-script.js", import.meta.url),
  );
  const config = Buffer.from(
    JSON.stringify({
      tools: opts.tools,
      ...(opts.crashOn !== undefined ? { crashOn: opts.crashOn } : {}),
      ...(opts.hangOn !== undefined ? { hangOn: opts.hangOn } : {}),
      ...(opts.isErrorOn !== undefined ? { isErrorOn: opts.isErrorOn } : {}),
    }),
  ).toString("base64");
  return { command: process.execPath, args: [scriptPath, "--config", config] };
};
