/**
 * anthropic-runner.ts
 *
 * AnthropicRunner — implements the Runner interface for the Anthropic Messages API.
 * Uses native /v1/messages format, not the OpenAI-compatible endpoint.
 *
 * MCP client management is re-used from @ageflow/runner-api.
 */

import type {
  Logger,
  McpServerConfig,
  Runner,
  RunnerSpawnArgs,
  RunnerSpawnResult,
} from "@ageflow/core";
import { McpPoolCollisionError } from "@ageflow/runner-api";
import type { ToolRegistry } from "@ageflow/runner-api";
import type { McpClient } from "../../api/src/mcp-client.js";
import { shutdownAll, startMcpClients } from "../../api/src/mcp-client.js";
import { mcpToolsToRegistry } from "../../api/src/mcp-tool-adapter.js";
import type { AnthropicResponse } from "./anthropic-types.js";
import {
  buildAnthropicMessages,
  toolsToAnthropicSchemas,
} from "./message-builder.js";
import {
  type AnthropicSessionStore,
  InMemoryAnthropicSessionStore,
} from "./session-store.js";
import {
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  runAnthropicToolLoop,
} from "./tool-loop.js";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AnthropicRunnerConfig {
  apiKey: string;
  /** Fallback model when AgentDef.model is not set. */
  defaultModel?: string;
  tools?: ToolRegistry;
  sessionStore?: AnthropicSessionStore;
  /** Default: 10. Hard ceiling against infinite tool loops. */
  maxToolRounds?: number;
  /** Default: 8192. Required by Anthropic API. */
  maxTokens?: number;
  /** Default: 120_000ms. Per individual API call. */
  requestTimeout?: number;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Optional logger. MCP subprocess stderr is teed here; never forwarded to the model. */
  logger?: Logger;
  /**
   * Extended thinking budget in tokens. When set, enables extended thinking mode.
   * Requires a claude-3-7-sonnet or later model.
   */
  thinkingBudgetTokens?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when two McpServerConfig objects would spawn an identical process.
 */
function isSpawnEquivalent(a: McpServerConfig, b: McpServerConfig): boolean {
  if (a.command !== b.command) return false;
  if (a.cwd !== b.cwd) return false;

  const aArgs = a.args ?? [];
  const bArgs = b.args ?? [];
  if (aArgs.length !== bArgs.length) return false;
  for (let i = 0; i < aArgs.length; i++) {
    if (aArgs[i] !== bArgs[i]) return false;
  }

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

// ─── Runner class ─────────────────────────────────────────────────────────────

export class AnthropicRunner implements Runner {
  private readonly apiKey: string;
  private readonly defaultModel: string | undefined;
  private readonly tools: ToolRegistry;
  private readonly sessionStore: AnthropicSessionStore;
  private readonly maxToolRounds: number;
  private readonly maxTokens: number;
  private readonly requestTimeout: number;
  private readonly fetch: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly thinkingBudgetTokens: number | undefined;
  /** Pool of long-lived MCP clients keyed by server name (reusePerRunner=true). */
  private readonly mcpPool = new Map<string, McpClient>();

  constructor(config: AnthropicRunnerConfig) {
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
    this.tools = config.tools ?? {};
    this.sessionStore =
      config.sessionStore ?? new InMemoryAnthropicSessionStore();
    this.maxToolRounds = config.maxToolRounds ?? DEFAULT_MAX_ROUNDS;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.requestTimeout = config.requestTimeout ?? DEFAULT_TIMEOUT_MS;
    this.fetch = config.fetch ?? globalThis.fetch;
    this.logger = config.logger;
    this.thinkingBudgetTokens = config.thinkingBudgetTokens;
  }

  async validate(): Promise<{ ok: boolean; version?: string; error?: string }> {
    // Anthropic doesn't have a /models endpoint in the public API.
    // We do a minimal real request: POST /v1/messages with 1 max_token
    // using the default model (or a known-valid model) to check the key.
    // If no defaultModel, we probe with claude-3-haiku-20240307.
    const probeModel = this.defaultModel ?? "claude-3-haiku-20240307";
    try {
      const resp = await this.fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: probeModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(this.requestTimeout),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return {
          ok: false,
          error: `HTTP ${resp.status} ${resp.statusText} ${text}`.trim(),
        };
      }

      const body = (await resp.json()) as AnthropicResponse;
      return { ok: true, version: body.model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async spawn(args: RunnerSpawnArgs): Promise<RunnerSpawnResult> {
    const model = args.model ?? this.defaultModel;
    if (!model) {
      throw new Error(
        "AnthropicRunner.spawn: model not set and no defaultModel configured",
      );
    }

    const handle =
      args.sessionHandle && args.sessionHandle.length > 0
        ? args.sessionHandle
        : crypto.randomUUID();

    const history = args.sessionHandle
      ? await this.sessionStore.get(args.sessionHandle)
      : undefined;

    const initialMessages = buildAnthropicMessages({
      prompt: args.prompt,
      history,
    });

    // Filter registry to caller's allowlist
    const filteredRegistry =
      args.tools !== undefined
        ? Object.fromEntries(
            Object.entries(this.tools).filter(([name]) =>
              (args.tools as string[]).includes(name),
            ),
          )
        : this.tools;

    // ── MCP clients ────────────────────────────────────────────────────────────
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

      const toolSchemas = toolsToAnthropicSchemas(merged, mergedToolsArg);

      const loop = await runAnthropicToolLoop({
        apiKey: this.apiKey,
        fetch: this.fetch,
        model,
        messages: initialMessages,
        system: args.systemPrompt,
        tools: toolSchemas,
        registry: merged,
        maxRounds: this.maxToolRounds,
        maxTokens: this.maxTokens,
        requestTimeout: this.requestTimeout,
        ...(this.thinkingBudgetTokens !== undefined
          ? { thinkingBudgetTokens: this.thinkingBudgetTokens }
          : {}),
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
      const toStop = perSpawnClients.filter((c) => !c.config.reusePerRunner);
      await Promise.allSettled(toStop.map((c) => c.stop()));
    }
  }

  async shutdown(): Promise<void> {
    await shutdownAll([...this.mcpPool.values()]);
    this.mcpPool.clear();
  }
}
