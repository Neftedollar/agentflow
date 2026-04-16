import { describe, expect, it } from "vitest";
import { MCP_SAFE_DEFAULTS, resolveMcpConfig } from "../mcp-defaults.js";

describe("resolveMcpConfig", () => {
  it("applies safe defaults when mcp is undefined", () => {
    const result = resolveMcpConfig(undefined);
    expect(result).toEqual({
      description: undefined,
      maxCostUsd: 1.0,
      maxDurationSec: 300,
      maxTurns: 20,
      inputTask: undefined,
      outputTask: undefined,
    });
  });

  it("merges partial config with defaults", () => {
    const result = resolveMcpConfig({ maxCostUsd: 5 });
    expect(result.maxCostUsd).toBe(5);
    expect(result.maxDurationSec).toBe(300);
    expect(result.maxTurns).toBe(20);
  });

  it('expands limits: "unsafe-unlimited" to all-null ceilings', () => {
    const result = resolveMcpConfig({ limits: "unsafe-unlimited" });
    expect(result.maxCostUsd).toBeNull();
    expect(result.maxDurationSec).toBeNull();
    expect(result.maxTurns).toBeNull();
  });

  it("preserves individual nulls", () => {
    const result = resolveMcpConfig({ maxCostUsd: null, maxDurationSec: 600 });
    expect(result.maxCostUsd).toBeNull();
    expect(result.maxDurationSec).toBe(600);
    expect(result.maxTurns).toBe(20); // default
  });

  it("throws when mcp === false (unexposable)", () => {
    expect(() => resolveMcpConfig(false)).toThrow(/WORKFLOW_NOT_MCP_EXPOSABLE/);
  });

  it("exports MCP_SAFE_DEFAULTS for reuse", () => {
    expect(MCP_SAFE_DEFAULTS).toEqual({
      maxCostUsd: 1.0,
      maxDurationSec: 300,
      maxTurns: 20,
    });
  });
});
