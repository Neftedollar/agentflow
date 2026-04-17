/**
 * message-builder.ts
 *
 * Build the initial messages array for Anthropic Messages API.
 * Note: system prompt is NOT included in messages — it goes in the `system` field.
 *
 * Also converts ToolRegistry → AnthropicToolSchema[].
 */

import type { ToolRegistry } from "@ageflow/runner-api";
import type {
  AnthropicMessage,
  AnthropicToolSchema,
} from "./anthropic-types.js";

export interface BuildAnthropicMessagesInput {
  prompt: string;
  /**
   * Prior conversation history. System messages are already excluded —
   * system prompt is kept in the `system` field of the request.
   */
  history: AnthropicMessage[] | undefined;
}

/**
 * Build the messages[] array for a new or resumed Anthropic session.
 *
 * Unlike the OpenAI runner, system prompts are NOT embedded in messages.
 * They go in the top-level `system` field of the request body.
 * This function only returns user/assistant turns.
 */
export function buildAnthropicMessages(
  input: BuildAnthropicMessagesInput,
): AnthropicMessage[] {
  const history = input.history ?? [];
  const out: AnthropicMessage[] = [...history];
  out.push({ role: "user", content: input.prompt });
  return out;
}

/**
 * Convert the subset of the runner's tool registry named in `names` into
 * Anthropic tool schemas. Unknown names are ignored.
 */
export function toolsToAnthropicSchemas(
  registry: ToolRegistry,
  names: readonly string[] | undefined,
): AnthropicToolSchema[] | undefined {
  if (!names || names.length === 0) return undefined;
  const out: AnthropicToolSchema[] = [];
  for (const name of names) {
    const def = registry[name];
    if (!def) continue;

    // Extract properties/required from the parameters schema if available
    const params = def.parameters;
    const inputSchema: AnthropicToolSchema["input_schema"] = {
      type: "object",
      ...(params && typeof params === "object" ? params : {}),
    };

    out.push({
      name,
      description: def.description,
      input_schema: inputSchema,
    });
  }
  return out.length > 0 ? out : undefined;
}
