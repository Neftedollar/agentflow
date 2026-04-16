import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToMcpSchema } from "../schema-convert.js";

describe("zodToMcpSchema", () => {
  it("converts a simple object schema", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = zodToMcpSchema(schema);
    expect(result.type).toBe("object");
    expect(result.properties?.name).toEqual({ type: "string" });
    expect(result.required).toContain("name");
  });

  it("handles optional fields", () => {
    const schema = z.object({ a: z.string(), b: z.string().optional() });
    const result = zodToMcpSchema(schema);
    expect(result.required).toEqual(["a"]);
  });

  it("handles arrays", () => {
    const schema = z.object({ items: z.array(z.string()) });
    const result = zodToMcpSchema(schema);
    expect(result.properties?.items).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
  });

  it("handles enums", () => {
    const schema = z.object({ status: z.enum(["ok", "fail"]) });
    const result = zodToMcpSchema(schema);
    expect(result.properties?.status).toMatchObject({ enum: ["ok", "fail"] });
  });

  it("strips $schema key", () => {
    const schema = z.object({ a: z.string() });
    const result = zodToMcpSchema(schema);
    // biome-ignore lint/suspicious/noExplicitAny: checking runtime shape
    expect((result as any).$schema).toBeUndefined();
  });

  it("returns empty object for non-object schemas", () => {
    const schema = z.string();
    const result = zodToMcpSchema(schema);
    expect(result.type).toBe("object");
  });
});
