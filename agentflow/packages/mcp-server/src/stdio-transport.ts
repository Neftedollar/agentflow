/**
 * stdio-transport.ts
 *
 * Wires @modelcontextprotocol/sdk's Server around the createMcpServer handle,
 * then connects to a transport (StdioServerTransport in production,
 * InMemoryTransport in tests).
 *
 * Handles:
 *   - tools/list  → handle.listTools()
 *   - tools/call  → handle.callTool() with progress streaming + elicitation bridge
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ElicitationResponse, McpConnectionLike } from "./hitl-bridge.js";
import type { ProgressPayload, SendProgress } from "./progress-streamer.js";
import type { McpServerHandle } from "./server.js";

// ─── Public options ──────────────────────────────────────────────────────────

export interface StdioTransportOptions {
  /** Human-readable server name (advertised during initialization). */
  readonly serverName: string;
  /** Server version string. */
  readonly serverVersion: string;
  /** The workflow server handle from createMcpServer(). */
  readonly handle: McpServerHandle;
  /** Optional stderr writer override (for testing). */
  readonly stderr?: (line: string) => void;
  /**
   * Transport override for testing.  When omitted a StdioServerTransport is
   * created automatically.
   */
  readonly transport?: Transport;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function makeProgressSender(
  sendNotification: (n: {
    method: string;
    params: Record<string, unknown>;
  }) => Promise<void>,
): SendProgress {
  return (payload: ProgressPayload): void => {
    void sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: payload.progressToken,
        progress: payload.progress,
        ...(payload.total !== undefined ? { total: payload.total } : {}),
        ...(payload.message !== undefined ? { message: payload.message } : {}),
      },
    });
  };
}

function makeConnection(
  sdkServer: Server,
  sendNotification: (n: {
    method: string;
    params: Record<string, unknown>;
  }) => Promise<void>,
): McpConnectionLike {
  return {
    supports(capability: "elicitation" | "progress"): boolean {
      if (capability === "elicitation") {
        return sdkServer.getClientCapabilities()?.elicitation !== undefined;
      }
      return true;
    },

    async elicit(req: {
      message: string;
      requestedSchema: Record<string, unknown>;
    }): Promise<ElicitationResponse> {
      const result = await sdkServer.elicitInput({
        message: req.message,
        requestedSchema: {
          type: "object" as const,
          properties: req.requestedSchema.properties as Record<
            string,
            { type: string; description?: string }
          >,
          required: (req.requestedSchema.required ?? []) as string[],
        },
      });
      return {
        action: result.action,
        content: result.content as Record<string, unknown> | undefined,
      };
    },
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register tools/list and tools/call handlers on a freshly-created SDK Server
 * and connect it to the given transport (or stdio when none provided).
 *
 * Returns the connected Server so callers can close it in tests.
 */
export async function startStdioTransport(
  opts: StdioTransportOptions,
): Promise<Server> {
  const { serverName, serverVersion, handle, transport } = opts;

  const writeStderr =
    opts.stderr ??
    ((line: string) => {
      process.stderr.write(line);
    });

  const sdkServer = new Server(
    { name: serverName, version: serverVersion },
    { capabilities: { tools: {} } },
  );

  // ── tools/list ────────────────────────────────────────────────────────────
  sdkServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await handle.listTools();
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // ── tools/call ────────────────────────────────────────────────────────────
  sdkServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const progressToken = request.params._meta?.progressToken;

    const connection = makeConnection(sdkServer, extra.sendNotification);
    const sendProgress = makeProgressSender(extra.sendNotification);

    const result = await handle.callTool(toolName, args, {
      connection,
      progressToken: progressToken ?? undefined,
      sendProgress: progressToken !== undefined ? sendProgress : undefined,
    });

    return {
      content: result.content as { type: "text"; text: string }[],
      isError: result.isError,
    };
  });

  const actualTransport = transport ?? new StdioServerTransport();

  writeStderr(
    `[ageflow mcp] ${serverName}@${serverVersion} listening on ${transport !== undefined ? "transport" : "stdio"}\n`,
  );

  await sdkServer.connect(actualTransport);
  return sdkServer;
}
