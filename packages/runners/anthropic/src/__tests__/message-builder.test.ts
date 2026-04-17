import type { ToolRegistry } from "@ageflow/runner-api";
import { describe, expect, it } from "vitest";
import type { AnthropicMessage } from "../anthropic-types.js";
import {
  buildAnthropicMessages,
  toolsToAnthropicSchemas,
} from "../message-builder.js";

describe("buildAnthropicMessages", () => {
  it("builds a single user message when no history", () => {
    const msgs = buildAnthropicMessages({
      prompt: "hello",
      history: undefined,
    });
    expect(msgs).toEqual([{ role: "user", content: "hello" }]);
  });

  it("appends prompt to existing history", () => {
    const history: AnthropicMessage[] = [
      { role: "user", content: "prior" },
      {
        role: "assistant",
        content: [{ type: "text", text: "prior reply" }],
      },
    ];
    const msgs = buildAnthropicMessages({ prompt: "next", history });
    expect(msgs.length).toBe(3);
    expect(msgs[2]).toEqual({ role: "user", content: "next" });
  });

  it("does NOT embed system prompt in messages (system goes in request field)", () => {
    // System prompt is handled by the caller — NOT inserted into messages[].
    const msgs = buildAnthropicMessages({
      prompt: "hi",
      history: undefined,
    });
    const hasSystemMsg = msgs.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.startsWith("SYSTEM:"),
    );
    expect(hasSystemMsg).toBe(false);
    expect(msgs).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("toolsToAnthropicSchemas", () => {
  const registry: ToolRegistry = {
    echo: {
      description: "echoes input",
      parameters: {
        type: "object",
        properties: { s: { type: "string" } },
        required: ["s"],
      },
      execute: async ({ s }) => s,
    },
    noop: {
      description: "does nothing",
      parameters: {},
      execute: async () => null,
    },
  };

  it("returns undefined when names is empty", () => {
    expect(toolsToAnthropicSchemas(registry, [])).toBeUndefined();
  });

  it("returns undefined when names is undefined", () => {
    expect(toolsToAnthropicSchemas(registry, undefined)).toBeUndefined();
  });

  it("converts named tools to Anthropic tool schema format", () => {
    const schemas = toolsToAnthropicSchemas(registry, ["echo"]);
    expect(schemas).toHaveLength(1);
    const schema = schemas?.[0];
    expect(schema?.name).toBe("echo");
    expect(schema?.description).toBe("echoes input");
    expect(schema?.input_schema.type).toBe("object");
  });

  it("ignores unknown tool names", () => {
    const schemas = toolsToAnthropicSchemas(registry, ["echo", "unknown"]);
    expect(schemas).toHaveLength(1);
    expect(schemas?.[0]?.name).toBe("echo");
  });

  it("returns undefined when all names are unknown", () => {
    expect(toolsToAnthropicSchemas(registry, ["unknown"])).toBeUndefined();
  });

  it("tool schema has input_schema with type: object", () => {
    const schemas = toolsToAnthropicSchemas(registry, ["noop"]);
    expect(schemas?.[0]?.input_schema).toMatchObject({ type: "object" });
  });
});
