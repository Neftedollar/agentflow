import type { ToolCallRecord } from "@ageflow/core";
import {
  ApiRequestError,
  MaxToolRoundsError,
  ToolNotFoundError,
} from "./errors.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ToolSchema,
} from "./openai-types.js";
import type { ToolRegistry } from "./types.js";

export interface RunToolLoopInput {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[] | undefined;
  registry: ToolRegistry;
  maxRounds: number;
  requestTimeout: number;
}

export interface RunToolLoopResult {
  finalText: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: ToolCallRecord[];
  finalMessages: ChatMessage[];
}

export async function runToolLoop(
  input: RunToolLoopInput,
): Promise<RunToolLoopResult> {
  const messages: ChatMessage[] = [...input.messages];
  const toolCalls: ToolCallRecord[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  for (let round = 0; round < input.maxRounds; round++) {
    const body: ChatCompletionRequest = {
      model: input.model,
      messages,
      ...(input.tools ? { tools: input.tools } : {}),
    };

    const resp = await postChat(input, body);
    tokensIn += resp.usage?.prompt_tokens ?? 0;
    tokensOut += resp.usage?.completion_tokens ?? 0;

    const choice = resp.choices[0];
    if (!choice) {
      throw new ApiRequestError(500, "no choices in response");
    }
    const assistant = choice.message;

    // Persist assistant turn (content may be null when only tool_calls are returned).
    messages.push({
      role: "assistant",
      content: assistant.content ?? "",
      ...(assistant.tool_calls ? { tool_calls: assistant.tool_calls } : {}),
    });

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        finalText: assistant.content ?? "",
        tokensIn,
        tokensOut,
        toolCalls,
        finalMessages: messages,
      };
    }

    for (const call of calls) {
      const name = call.function.name;
      const rawArgs = call.function.arguments;
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs =
          rawArgs === ""
            ? {}
            : (JSON.parse(rawArgs) as Record<string, unknown>);
      } catch {
        parsedArgs = { __raw: rawArgs };
      }

      const def = input.registry[name];
      const startedAt = Date.now();
      let result: unknown;
      try {
        if (!def) {
          throw new ToolNotFoundError(name);
        }
        result = await def.execute(parsedArgs);
      } catch (err) {
        if (err instanceof ToolNotFoundError) {
          throw err;
        }
        result = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      const durationMs = Date.now() - startedAt;

      toolCalls.push({ name, args: parsedArgs, result, durationMs });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }

  throw new MaxToolRoundsError(input.maxRounds);
}

async function postChat(
  input: RunToolLoopInput,
  body: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.requestTimeout);
  try {
    const sanitized = Object.fromEntries(
      Object.entries(input.headers).filter(
        ([k]) => k.toLowerCase() !== "authorization",
      ),
    );
    const resp = await input.fetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
        ...sanitized,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new ApiRequestError(resp.status, text);
    }
    return (await resp.json()) as ChatCompletionResponse;
  } finally {
    clearTimeout(timer);
  }
}
