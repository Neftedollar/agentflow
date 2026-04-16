import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Build the system prompt that instructs an agent to respond with structured
 * JSON conforming to the agent's output Zod schema.
 *
 * The generated JSON Schema is embedded verbatim so the agent knows the exact
 * shape required. `output-parser.ts` enforces this contract on the way back.
 */
export function buildOutputSchemaPrompt(outputSchema: ZodType): string {
  const jsonSchema = zodToJsonSchema(outputSchema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;

  // Drop the $schema meta-field — not useful inside a system prompt
  jsonSchema.$schema = undefined;

  const schemaJson = JSON.stringify(jsonSchema, null, 2);

  return [
    "You MUST respond with valid JSON that matches this schema exactly.",
    "Do not include any text, markdown, or explanation before or after the JSON object.",
    "",
    "Output schema:",
    "```json",
    schemaJson,
    "```",
  ].join("\n");
}
