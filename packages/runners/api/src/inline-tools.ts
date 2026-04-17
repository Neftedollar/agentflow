/**
 * inline-tools.ts
 *
 * Utilities for converting InlineToolDef (from @ageflow/core) into ToolDefinition
 * objects used by the runner-api ToolRegistry.
 *
 * Conversion uses zod-to-json-schema to turn the Zod parameter schema into an
 * OpenAI-compatible JSON schema object.
 */

import type { InlineToolDef } from "@ageflow/core";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition, ToolRegistry } from "./types.js";

/**
 * Convert a single InlineToolDef to a ToolDefinition (ToolRegistry entry).
 *
 * The Zod `parameters` schema is converted to a JSON schema using
 * zod-to-json-schema with the jsonSchema7 target, which is OpenAI-compatible.
 *
 * At call time, args from the model arrive as `Record<string, unknown>`.
 * We pass them through the Zod schema for runtime validation before calling
 * `execute` — this gives the typed `I` the user declared.
 */
export function inlineToolDefToToolDefinition(
  def: InlineToolDef,
): ToolDefinition {
  const parametersSchema = zodToJsonSchema(def.parameters, {
    target: "jsonSchema7",
  }) as Record<string, unknown>;

  return {
    description: def.description,
    parameters: parametersSchema,
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      // Runtime validation through the Zod schema — gives type-safe `I`
      const parsed = def.parameters.safeParse(args);
      if (!parsed.success) {
        throw new Error(
          `Inline tool argument validation failed: ${parsed.error.message}`,
        );
      }
      return def.execute(parsed.data);
    },
  };
}

/**
 * Convert a map of InlineToolDef entries to a ToolRegistry.
 */
export function inlineToolsToRegistry(
  inlineDefs: Readonly<Record<string, InlineToolDef>>,
): ToolRegistry {
  const registry: ToolRegistry = {};
  for (const [name, def] of Object.entries(inlineDefs)) {
    registry[name] = inlineToolDefToToolDefinition(def);
  }
  return registry;
}

/**
 * Merge tool sources for a single spawn() call.
 *
 * Precedence (later wins): instance < agent < per-call.
 *
 * - instanceTools:  tools from ApiRunner / AnthropicRunner constructor
 * - agentTools:     inline tools from AgentDef.tools (when it is a map)
 * - perCallTools:   RunnerSpawnArgs.inlineTools (set by executor from runnerOverrides)
 *
 * Returns the merged ToolRegistry.
 */
export function mergeInlineTools(
  instanceTools: ToolRegistry,
  agentTools: Readonly<Record<string, InlineToolDef>> | undefined,
  perCallTools: Readonly<Record<string, InlineToolDef>> | undefined,
): ToolRegistry {
  const merged: ToolRegistry = { ...instanceTools };

  if (agentTools !== undefined) {
    for (const [name, def] of Object.entries(agentTools)) {
      merged[name] = inlineToolDefToToolDefinition(def);
    }
  }

  if (perCallTools !== undefined) {
    for (const [name, def] of Object.entries(perCallTools)) {
      merged[name] = inlineToolDefToToolDefinition(def);
    }
  }

  return merged;
}
