import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOutputSchemaPrompt } from "../schema-prompt.js";

describe("buildOutputSchemaPrompt", () => {
  it("includes the JSON schema for a simple object schema", () => {
    const schema = z.object({
      result: z.string(),
      score: z.number(),
    });

    const prompt = buildOutputSchemaPrompt(schema);

    expect(prompt).toContain("You MUST respond with valid JSON");
    expect(prompt).toContain('"result"');
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"type": "string"');
    expect(prompt).toContain('"type": "number"');
  });

  it("instructs agent not to include text before or after the JSON", () => {
    const schema = z.object({ value: z.string() });
    const prompt = buildOutputSchemaPrompt(schema);

    expect(prompt).toContain("Do not include any text");
  });

  it("wraps schema in a code fence", () => {
    const schema = z.object({ ok: z.boolean() });
    const prompt = buildOutputSchemaPrompt(schema);

    expect(prompt).toContain("```json");
    expect(prompt).toContain("```");
  });

  it("does not include the $schema meta-field", () => {
    const schema = z.object({ x: z.string() });
    const prompt = buildOutputSchemaPrompt(schema);

    expect(prompt).not.toContain('"$schema"');
    expect(prompt).not.toContain("json-schema.org");
  });

  it("produces valid JSON inside the fence", () => {
    const schema = z.object({ items: z.array(z.string()), count: z.number() });
    const prompt = buildOutputSchemaPrompt(schema);

    const fenceMatch = /```json\s*([\s\S]*?)\s*```/.exec(prompt);
    expect(fenceMatch).not.toBeNull();
    const jsonStr = fenceMatch?.[1] ?? "";
    expect(() => JSON.parse(jsonStr)).not.toThrow();
  });

  it("handles nested object schemas", () => {
    const schema = z.object({
      outer: z.object({
        inner: z.string(),
      }),
    });

    const prompt = buildOutputSchemaPrompt(schema);
    expect(prompt).toContain('"outer"');
    expect(prompt).toContain('"inner"');
  });
});
