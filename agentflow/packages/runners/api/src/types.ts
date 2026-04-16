import type { Logger } from "@ageflow/core";
import type { SessionStore } from "./session-store.js";
export type { SessionStore } from "./session-store.js";
export type { ToolCallRecord } from "@ageflow/core";
export type { Logger };

export interface ToolDefinition {
  /** Human-readable description surfaced to the model. */
  description: string;
  /** JSON schema for the tool's arguments (OpenAI function-call format). */
  parameters: Record<string, unknown>;
  /** Synchronous or async. Errors are caught and sent back to the model. */
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export type ToolRegistry = Record<string, ToolDefinition>;

export interface ApiRunnerConfig {
  /** e.g. "https://api.openai.com/v1" — no trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** Fallback model when AgentDef.model is not set. */
  defaultModel?: string;
  tools?: ToolRegistry;
  sessionStore?: SessionStore;
  /** Default: 10. Hard ceiling against infinite tool loops. */
  maxToolRounds?: number;
  /** Default: 120_000ms. Per individual API call. */
  requestTimeout?: number;
  /** Extra headers (Helicone, Portkey, Azure `api-version`). */
  headers?: Record<string, string>;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Optional logger. MCP subprocess stderr is teed here; never forwarded to the model. */
  logger?: Logger;
}
