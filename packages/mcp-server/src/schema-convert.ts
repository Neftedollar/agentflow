import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface McpJsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Convert a Zod schema to a JSON Schema shape suitable for MCP tool registration.
 *
 * MCP requires inputSchema/outputSchema to be of type "object" at the top level.
 * If the Zod root isn't an object, we wrap the result as a single-property object.
 */
export function zodToMcpSchema(schema: ZodType): McpJsonSchema {
  const raw = zodToJsonSchema(schema, { target: "jsonSchema7" }) as Record<
    string,
    unknown
  >;

  // Strip $schema (MCP schemas shouldn't carry JSON-Schema-draft URL)
  raw.$schema = undefined;

  if (raw.type === "object") {
    return raw as McpJsonSchema;
  }

  // Non-object root: wrap so the tool still registers (edge case)
  return {
    type: "object",
    properties: { value: raw },
    required: ["value"],
  };
}
