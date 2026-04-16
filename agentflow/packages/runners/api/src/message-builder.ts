import type { ChatMessage, ToolSchema } from "./openai-types.js";
import type { ToolRegistry } from "./types.js";

export interface BuildMessagesInput {
  prompt: string;
  systemPrompt: string | undefined;
  history: ChatMessage[] | undefined;
}

/**
 * Build the initial messages[] array for a new (or resumed) session.
 *
 * When a systemPrompt is provided it always wins: any prior system message in
 * history is replaced so that stale per-task output-schema instructions do not
 * persist across resumed sessions.  When no systemPrompt is provided the
 * history is used as-is (existing system message, if any, is kept).
 */
export function buildInitialMessages(input: BuildMessagesInput): ChatMessage[] {
  const history = input.history ?? [];
  const out: ChatMessage[] = [];

  if (input.systemPrompt && input.systemPrompt.length > 0) {
    // Prepend new system prompt and strip any prior system message from history
    out.push({ role: "system", content: input.systemPrompt });
    out.push(...history.filter((m) => m.role !== "system"));
  } else {
    out.push(...history);
  }

  out.push({ role: "user", content: input.prompt });
  return out;
}

/**
 * Convert the subset of the runner's tool registry named in `names` into
 * OpenAI tool schemas. Unknown names are ignored (executor is responsible
 * for validating tool names against the registry before spawn).
 */
export function toolsToSchemas(
  registry: ToolRegistry,
  names: readonly string[] | undefined,
): ToolSchema[] | undefined {
  if (!names || names.length === 0) return undefined;
  const out: ToolSchema[] = [];
  for (const name of names) {
    const def = registry[name];
    if (!def) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: def.description,
        parameters: def.parameters,
      },
    });
  }
  return out.length > 0 ? out : undefined;
}
