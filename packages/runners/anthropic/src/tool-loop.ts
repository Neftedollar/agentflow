/**
 * tool-loop.ts
 *
 * runAnthropicToolLoop() — the core request/tool-call loop for the Anthropic
 * Messages API. Separate from runner-api because the message format is
 * different (tool_result blocks vs OpenAI's "tool" role messages).
 */

import type { ToolCallRecord } from "@ageflow/core";
import type { ToolRegistry } from "@ageflow/runner-api";
import type {
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicToolSchema,
  ToolResultBlock,
} from "./anthropic-types.js";
import { MaxToolRoundsError, ToolNotFoundError } from "./errors.js";
import { AnthropicRequestError } from "./errors.js";

// ─── API constants ────────────────────────────────────────────────────────────

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MAX_TOKENS = 8192;

// ─── I/O types ────────────────────────────────────────────────────────────────

export interface RunAnthropicToolLoopInput {
  apiKey: string;
  fetch: typeof fetch;
  model: string;
  messages: AnthropicMessage[];
  system: string | undefined;
  tools: AnthropicToolSchema[] | undefined;
  registry: ToolRegistry;
  maxRounds: number;
  maxTokens: number;
  requestTimeout: number;
  thinkingBudgetTokens?: number;
}

export interface RunAnthropicToolLoopResult {
  finalText: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: ToolCallRecord[];
  finalMessages: AnthropicMessage[];
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export async function runAnthropicToolLoop(
  input: RunAnthropicToolLoopInput,
): Promise<RunAnthropicToolLoopResult> {
  const messages: AnthropicMessage[] = [...input.messages];
  const toolCalls: ToolCallRecord[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  for (let round = 0; round < input.maxRounds; round++) {
    const body: AnthropicRequest = {
      model: input.model,
      max_tokens: input.maxTokens,
      messages,
      ...(input.system ? { system: input.system } : {}),
      ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
      ...(input.thinkingBudgetTokens !== undefined
        ? {
            thinking: {
              type: "enabled",
              budget_tokens: input.thinkingBudgetTokens,
            },
          }
        : {}),
    };

    const resp = await postMessages(input, body);
    tokensIn += resp.usage?.input_tokens ?? 0;
    tokensOut += resp.usage?.output_tokens ?? 0;

    // Add assistant turn to history
    messages.push({ role: "assistant", content: resp.content });

    if (
      resp.stop_reason === "end_turn" ||
      resp.stop_reason === "stop_sequence" ||
      resp.stop_reason === "max_tokens"
    ) {
      // Extract final text from content blocks
      const finalText = extractFinalText(resp.content);
      return {
        finalText,
        tokensIn,
        tokensOut,
        toolCalls,
        finalMessages: messages,
      };
    }

    if (resp.stop_reason === "tool_use") {
      // Find all tool_use blocks
      const toolUseBlocks = resp.content.filter((b) => b.type === "tool_use");

      if (toolUseBlocks.length === 0) {
        // stop_reason is tool_use but no tool blocks — treat as end_turn
        const finalText = extractFinalText(resp.content);
        return {
          finalText,
          tokensIn,
          tokensOut,
          toolCalls,
          finalMessages: messages,
        };
      }

      const toolResults: ToolResultBlock[] = [];

      for (const block of toolUseBlocks) {
        if (block.type !== "tool_use") continue;

        const name = block.name;
        const args = block.input;
        const def = input.registry[name];
        const startedAt = Date.now();
        let result: unknown;

        try {
          if (!def) {
            throw new ToolNotFoundError(name);
          }
          result = await def.execute(args);
        } catch (err) {
          if (err instanceof ToolNotFoundError) {
            throw err;
          }
          result = `error: ${err instanceof Error ? err.message : String(err)}`;
        }

        const durationMs = Date.now() - startedAt;
        toolCalls.push({ name, args, result, durationMs });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }

      // Append tool results as a single user message
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unknown stop_reason — treat as end_turn
    const finalText = extractFinalText(resp.content);
    return {
      finalText,
      tokensIn,
      tokensOut,
      toolCalls,
      finalMessages: messages,
    };
  }

  throw new MaxToolRoundsError(input.maxRounds);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFinalText(content: AnthropicResponse["content"]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

async function postMessages(
  input: RunAnthropicToolLoopInput,
  body: AnthropicRequest,
): Promise<AnthropicResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.requestTimeout);
  try {
    const resp = await input.fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new AnthropicRequestError(resp.status, text);
    }

    return (await resp.json()) as AnthropicResponse;
  } finally {
    clearTimeout(timer);
  }
}
