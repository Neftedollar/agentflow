import type { Runner, RunnerSpawnArgs, RunnerSpawnResult } from "@ageflow/core";
import { buildInitialMessages, toolsToSchemas } from "./message-builder.js";
import type { ChatMessage } from "./openai-types.js";
import { InMemorySessionStore, type SessionStore } from "./session-store.js";
import { runToolLoop } from "./tool-loop.js";
import type { ApiRunnerConfig, ToolRegistry } from "./types.js";

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
  }

  async validate(): Promise<{ ok: boolean; version?: string; error?: string }> {
    // Stub — real implementation is Phase 6
    return { ok: true };
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

    const toolSchemas = toolsToSchemas(this.tools, args.tools);

    const loop = await runToolLoop({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      headers: this.headers,
      fetch: this.fetch,
      model,
      messages: initialMessages,
      tools: toolSchemas,
      registry: this.tools,
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
  }
}
