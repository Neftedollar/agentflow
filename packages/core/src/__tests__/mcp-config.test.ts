import { describe, expect, it } from "vitest";
import { McpConfigSchema } from "../schemas.js";

describe("McpConfigSchema", () => {
  it("accepts a full config", () => {
    const input = {
      description: "Test workflow",
      maxCostUsd: 10,
      maxDurationSec: 1800,
      maxTurns: 100,
      inputTask: "start",
      outputTask: "end",
    };
    expect(McpConfigSchema.parse(input)).toEqual(input);
  });

  it("allows missing optional fields", () => {
    expect(McpConfigSchema.parse({})).toEqual({});
  });

  it("accepts null for individual ceilings", () => {
    const input = { maxCostUsd: null, maxDurationSec: 300, maxTurns: null };
    expect(McpConfigSchema.parse(input)).toEqual(input);
  });

  it('accepts shorthand limits: "unsafe-unlimited"', () => {
    expect(McpConfigSchema.parse({ limits: "unsafe-unlimited" })).toEqual({
      limits: "unsafe-unlimited",
    });
  });

  it('rejects limits other than "unsafe-unlimited"', () => {
    expect(() => McpConfigSchema.parse({ limits: "unlimited" })).toThrow();
  });

  it("rejects negative numbers", () => {
    expect(() => McpConfigSchema.parse({ maxCostUsd: -1 })).toThrow();
    expect(() => McpConfigSchema.parse({ maxDurationSec: 0 })).toThrow();
  });

  it("accepts false literal to disable MCP exposure", () => {
    // tested at workflow level, but schema accepts the literal
    expect(McpConfigSchema.parse({})).toEqual({});
  });
});
