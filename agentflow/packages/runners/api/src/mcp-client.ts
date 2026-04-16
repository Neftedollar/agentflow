/**
 * mcp-client.ts
 *
 * Thin wrapper over @modelcontextprotocol/sdk StdioClientTransport + Client.
 * Exposes McpClient, startMcpClients(), and shutdownAll().
 *
 * Error classes:
 *   McpServerStartFailedError  — spawn / initialize failed
 *   McpToolCallFailedError     — tool invocation returned isError:true or threw
 *
 * Per-call timeout: mcpCallTimeoutMs (default 30 s). On timeout, server is
 * sent SIGTERM then SIGKILL after 5 s.
 */

import { AgentFlowError } from "@ageflow/core";
import type { Logger, McpServerConfig, McpToolDescriptor } from "@ageflow/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type { McpToolDescriptor };

// ─── Errors ───────────────────────────────────────────────────────────────────

export class McpServerStartFailedError extends AgentFlowError {
  readonly code = "mcp_server_start_failed" as const;
  constructor(
    readonly serverName: string,
    cause?: unknown,
  ) {
    const msg =
      cause instanceof Error ? cause.message : String(cause ?? "unknown");
    super(`mcp_server_start_failed: ${serverName}: ${msg}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}

export class McpToolCallFailedError extends AgentFlowError {
  readonly code = "mcp_tool_call_failed" as const;
  constructor(
    readonly toolName: string,
    cause?: unknown,
  ) {
    const msg =
      cause instanceof Error ? cause.message : String(cause ?? "unknown");
    super(`mcp_tool_call_failed: ${toolName}: ${msg}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface McpClient {
  readonly config: McpServerConfig;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const SIGKILL_GRACE_MS = 5_000;

// ─── Implementation ───────────────────────────────────────────────────────────

class McpClientImpl implements McpClient {
  readonly config: McpServerConfig;
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly callTimeoutMs: number;
  private readonly logger: Logger | undefined;

  constructor(
    config: McpServerConfig,
    client: Client,
    transport: StdioClientTransport,
    logger?: Logger,
  ) {
    this.config = config;
    this.client = client;
    this.transport = transport;
    this.callTimeoutMs = config.mcpCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.logger = logger;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const res = await this.client.listTools();
    return res.tools.map(
      (t): McpToolDescriptor => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
      }),
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const timeoutMs = this.callTimeoutMs;

    // C3: AbortController so the SDK cleans up the in-flight RPC on timeout
    const ctrl = new AbortController();

    const doCall = this.client.callTool({ name, arguments: args }, undefined, {
      signal: ctrl.signal,
    });

    // C1: hoist the SIGTERM timer so the finally block can cancel it on the
    //     happy path, preventing spurious SIGTERM after a successful call.
    let sigtermTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // C2: track whether SIGTERM was sent so we do NOT cancel the SIGKILL timer
    //     when the timeout path runs through finally.
    let sentSigterm = false;

    const timeout = new Promise<never>((_, reject) => {
      sigtermTimer = setTimeout(() => {
        // Try SIGTERM first, then SIGKILL after grace period
        const pid = this.transport.pid;
        if (pid !== null) {
          try {
            process.kill(pid, "SIGTERM");
            sentSigterm = true;
          } catch {
            // process may already be gone
          }
          killTimer = setTimeout(() => {
            if (pid !== null) {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                // ignore
              }
            }
          }, SIGKILL_GRACE_MS);
          killTimer.unref?.();
        }
        // C3: abort the in-flight SDK request so the client cleans up the
        //     pending request ID and does not process a late server reply.
        ctrl.abort();
        reject(
          new McpToolCallFailedError(
            name,
            new Error(`timeout after ${timeoutMs}ms`),
          ),
        );
      }, timeoutMs);
      // Allow the process to exit without waiting for this timer
      sigtermTimer.unref?.();
    });

    try {
      const res = await Promise.race([doCall, timeout]);
      // Treat isError:true as an error
      if (
        res !== null &&
        typeof res === "object" &&
        "isError" in res &&
        res.isError === true
      ) {
        const content =
          "content" in res && Array.isArray(res.content)
            ? (res.content as Array<{ type: string; text?: string }>)
                .map((c) => c.text ?? "")
                .join(" ")
            : "";
        throw new McpToolCallFailedError(
          name,
          new Error(content || "isError:true"),
        );
      }
      return res;
    } finally {
      // C1: always clear the SIGTERM timer — on the happy path it hasn't fired
      //     yet and must be cancelled to prevent spurious kills.
      clearTimeout(sigtermTimer);
      // C2: only cancel the SIGKILL escalation if SIGTERM was never sent
      //     (i.e. happy path). When sentSigterm is true we are on the timeout
      //     path and the SIGKILL timer must be allowed to fire.
      if (!sentSigterm && killTimer !== undefined) {
        clearTimeout(killTimer);
      }
    }
  }

  async stop(): Promise<void> {
    try {
      await this.client.close();
    } catch (err) {
      this.logger?.warn(
        `McpClient.stop: close error for ${this.config.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Start one McpClient per McpServerConfig entry by spawning each as a stdio subprocess.
 * All clients are started concurrently. On any failure, already-started clients are
 * shut down and McpServerStartFailedError is thrown.
 */
export async function startMcpClients(
  servers: readonly McpServerConfig[],
  logger?: Logger,
): Promise<McpClient[]> {
  const started: McpClient[] = [];

  for (const cfg of servers) {
    let client: McpClientImpl;
    try {
      client = await startOne(cfg, logger);
    } catch (err) {
      // Rollback already-started clients
      await Promise.allSettled(started.map((c) => c.stop()));
      throw new McpServerStartFailedError(
        cfg.name,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    started.push(client);
  }

  return started;
}

async function startOne(
  cfg: McpServerConfig,
  logger?: Logger,
): Promise<McpClientImpl> {
  const env: Record<string, string> = cfg.env
    ? Object.fromEntries(
        Object.entries(cfg.env).map(([k, v]) => [
          k,
          // Basic ${env:VAR} substitution (already resolved by executor; kept for safety)
          v.replace(
            /\$\{env:([^}]+)\}/g,
            (_, name: string) => process.env[name] ?? "",
          ),
        ]),
      )
    : {};

  const hasEnv = Object.keys(env).length > 0;
  const hasCwd = cfg.cwd !== undefined;
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ? [...cfg.args] : [],
    ...(hasEnv ? { env } : {}),
    ...(hasCwd ? { cwd: cfg.cwd } : {}),
    stderr: "pipe",
  });

  // Tee stderr to logger — never forwarded to the model
  transport.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trimEnd();
    if (text) {
      logger?.debug(`[mcp:${cfg.name}] ${text}`);
    }
  });

  const sdkClient = new Client(
    { name: "ageflow-runner-api", version: "0.2.0" },
    { capabilities: {} },
  );

  // connect() will throw if the subprocess fails to start or initialize
  await sdkClient.connect(transport);

  return new McpClientImpl(cfg, sdkClient, transport, logger);
}

/**
 * Shut down all clients concurrently. Errors are ignored.
 */
export async function shutdownAll(
  clients: readonly McpClient[],
): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.stop()));
}
