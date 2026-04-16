import type {
  Logger,
  McpServerConfig,
  Runner,
  RunnerSpawnArgs,
  RunnerSpawnResult,
} from "@ageflow/core";
import { McpPoolCollisionError } from "./errors.js";
import type { McpClient } from "./mcp-client.js";
import { shutdownAll, startMcpClients } from "./mcp-client.js";
import { mcpToolsToRegistry } from "./mcp-tool-adapter.js";
import { buildInitialMessages, toolsToSchemas } from "./message-builder.js";
import type { ChatMessage } from "./openai-types.js";
import { InMemorySessionStore, type SessionStore } from "./session-store.js";
import { runToolLoop } from "./tool-loop.js";
import type { ApiRunnerConfig, ToolRegistry } from "./types.js";

/**
 * Returns true when two McpServerConfig objects would spawn an identical
 * process. Compares all spawn-determining fields: command, args, env, cwd,
 * and tools allowlist.
 */
function isSpawnEquivalent(a: McpServerConfig, b: McpServerConfig): boolean {
  if (a.command !== b.command) return false;
  if (a.cwd !== b.cwd) return false;

  // args: both absent/empty counts as equal
  const aArgs = a.args ?? [];
  const bArgs = b.args ?? [];
  if (aArgs.length !== bArgs.length) return false;
  for (let i = 0; i < aArgs.length; i++) {
    if (aArgs[i] !== bArgs[i]) return false;
  }

  // env: both absent/empty counts as equal
  const aEnvEntries = Object.entries(a.env ?? {}).sort(([k1], [k2]) =>
    k1 < k2 ? -1 : k1 > k2 ? 1 : 0,
  );
  const bEnvEntries = Object.entries(b.env ?? {}).sort(([k1], [k2]) =>
    k1 < k2 ? -1 : k1 > k2 ? 1 : 0,
  );
  if (aEnvEntries.length !== bEnvEntries.length) return false;
  for (let i = 0; i < aEnvEntries.length; i++) {
    const ae = aEnvEntries[i];
    const be = bEnvEntries[i];
    if (ae === undefined || be === undefined) return false;
    if (ae[0] !== be[0]) return false;
    if (ae[1] !== be[1]) return false;
  }

  // tools allowlist
  const aTools = a.tools ? [...a.tools].sort() : undefined;
  const bTools = b.tools ? [...b.tools].sort() : undefined;
  if ((aTools === undefined) !== (bTools === undefined)) return false;
  if (aTools !== undefined && bTools !== undefined) {
    if (aTools.length !== bTools.length) return false;
    for (let i = 0; i < aTools.length; i++) {
      if (aTools[i] !== bTools[i]) return false;
    }
  }

  return true;
}

const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;

export class ApiRunner implements Runner {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string | undefined;
  private readonly tools: ToolRegistry;
  private readonly sessionStore: SessionStore;
  private readonly maxToolRounds: number;
  private readonly requestTimeout: number;
  private readonly headers: Record<string, string>;
  private readonly fetch: typeof fetch;
  private readonly logger: Logger | undefined;
  /** Pool of long-lived MCP clients keyed by server name (reusePerRunner=true). */
  private readonly mcpPool = new Map<string, McpClient>();

  constructor(config: ApiRunnerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
    this.tools = config.tools ?? {};
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    this.maxToolRounds = config.maxToolRounds ?? DEFAULT_MAX_ROUNDS;
    this.requestTimeout = config.requestTimeout ?? DEFAULT_TIMEOUT_MS;
    this.headers = config.headers ?? {};
    this.fetch = config.fetch ?? globalThis.fetch;
    this.logger = config.logger;
  }

  async validate(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const sanitized = Object.fromEntries(
        Object.entries(this.headers).filter(
          ([k]) => k.toLowerCase() !== "authorization",
        ),
      );
      const res = await this.fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...sanitized,
        },
        signal: AbortSignal.timeout(this.requestTimeout),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `HTTP ${res.status} ${res.statusText}`.trim(),
        };
      }
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const version = body.data?.[0]?.id;
      return { ok: true, ...(version !== undefined ? { version } : {}) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async spawn(args: RunnerSpawnArgs): Promise<RunnerSpawnResult> {
    const model = args.model ?? this.defaultModel;
    if (!model) {
      throw new Error(
        "ApiRunner.spawn: model not set and no defaultModel configured",
      );
    }

    const handle =
      args.sessionHandle && args.sessionHandle.length > 0
        ? args.sessionHandle
        : crypto.randomUUID();

    const history: ChatMessage[] | undefined = args.sessionHandle
      ? await this.sessionStore.get(args.sessionHandle)
      : undefined;

    const initialMessages = buildInitialMessages({
      prompt: args.prompt,
      systemPrompt: args.systemPrompt,
      history,
    });

    // P1-3: filter the runtime registry to the caller's allowlist so that
    // tools not in args.tools cannot be executed even if the model names them.
    const filteredRegistry =
      args.tools !== undefined
        ? Object.fromEntries(
            Object.entries(this.tools).filter(([name]) =>
              (args.tools as string[]).includes(name),
            ),
          )
        : this.tools;

    // ── MCP clients ────────────────────────────────────────────────────────
    const servers = args.mcpServers ?? [];
    const perSpawnClients: McpClient[] = [];

    if (servers.length > 0) {
      try {
        for (const s of servers) {
          if (s.reusePerRunner) {
            let pooled = this.mcpPool.get(s.name);
            if (!pooled) {
              const [started] = await startMcpClients([s], this.logger);
              if (started === undefined) {
                throw new Error(
                  `startMcpClients returned no client for ${s.name}`,
                );
              }
              pooled = started;
              this.mcpPool.set(s.name, pooled);
            } else if (!isSpawnEquivalent(pooled.config, s)) {
              throw new McpPoolCollisionError(s.name);
            }
            perSpawnClients.push(pooled);
          } else {
            const [c] = await startMcpClients([s], this.logger);
            if (c === undefined) {
              throw new Error(
                `startMcpClients returned no client for ${s.name}`,
              );
            }
            perSpawnClients.push(c);
          }
        }
      } catch (startErr) {
        // Partial-startup leak guard: stop any non-pooled clients that already
        // started before the failure. Pooled clients stay in mcpPool for reuse.
        const toStop = perSpawnClients.filter((c) => !c.config.reusePerRunner);
        await shutdownAll(toStop);
        throw startErr;
      }
    }

    try {
      const mcpRegistry = await mcpToolsToRegistry(perSpawnClients);
      const merged: ToolRegistry = { ...filteredRegistry, ...mcpRegistry };

      const mergedToolsArg: string[] | undefined =
        args.tools !== undefined
          ? [...args.tools, ...Object.keys(mcpRegistry)]
          : Object.keys(mcpRegistry).length > 0
            ? [...Object.keys(filteredRegistry), ...Object.keys(mcpRegistry)]
            : args.tools;

      const toolSchemas = toolsToSchemas(merged, mergedToolsArg);

      const loop = await runToolLoop({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        headers: this.headers,
        fetch: this.fetch,
        model,
        messages: initialMessages,
        tools: toolSchemas,
        registry: merged,
        maxRounds: this.maxToolRounds,
        requestTimeout: this.requestTimeout,
      });

      await this.sessionStore.set(handle, loop.finalMessages);

      return {
        stdout: loop.finalText,
        sessionHandle: handle,
        tokensIn: loop.tokensIn,
        tokensOut: loop.tokensOut,
        toolCalls: loop.toolCalls,
      };
    } finally {
      // Stop per-spawn clients only — pooled clients live until shutdown().
      const toStop = perSpawnClients.filter((c) => !c.config.reusePerRunner);
      await Promise.allSettled(toStop.map((c) => c.stop()));
    }
  }

  /**
   * Drain the pooled MCP clients. Invoked by the workflow executor on
   * workflow completion / abort (Phase 7 wires this call; runner exposes it now).
   */
  async shutdown(): Promise<void> {
    await shutdownAll([...this.mcpPool.values()]);
    this.mcpPool.clear();
  }
}
