import type { ResolvedMcpConfig } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { composeCeilings } from "../ceiling-resolver.js";

const baseWorkflow: ResolvedMcpConfig = {
  description: undefined,
  maxCostUsd: 10,
  maxDurationSec: 1800,
  maxTurns: 100,
  inputTask: undefined,
  outputTask: undefined,
};

describe("composeCeilings", () => {
  it("takes workflow value when CLI not set", () => {
    const result = composeCeilings(baseWorkflow, {});
    expect(result.maxCostUsd).toBe(10);
    expect(result.maxDurationSec).toBe(1800);
    expect(result.maxTurns).toBe(100);
  });

  it("operator can lower ceiling", () => {
    const result = composeCeilings(baseWorkflow, { maxCostUsd: 5 });
    expect(result.maxCostUsd).toBe(5);
  });

  it("operator cannot raise ceiling (clamps + warns)", () => {
    const warnings: string[] = [];
    const result = composeCeilings(baseWorkflow, { maxCostUsd: 50 }, (w) =>
      warnings.push(w),
    );
    expect(result.maxCostUsd).toBe(10);
    expect(warnings[0]).toMatch(/clamped/);
  });

  it("null workflow ceiling = +Infinity, CLI value wins", () => {
    const w = { ...baseWorkflow, maxCostUsd: null };
    const result = composeCeilings(w, { maxCostUsd: 5 });
    expect(result.maxCostUsd).toBe(5);
  });

  it("null CLI ceiling (--no-max-cost) ignored if workflow set", () => {
    const warnings: string[] = [];
    const result = composeCeilings(baseWorkflow, { maxCostUsd: null }, (w) =>
      warnings.push(w),
    );
    expect(result.maxCostUsd).toBe(10);
    expect(warnings[0]).toMatch(/ignored/);
  });

  it("both null = unlimited", () => {
    const w = { ...baseWorkflow, maxCostUsd: null };
    const result = composeCeilings(w, { maxCostUsd: null });
    expect(result.maxCostUsd).toBeNull();
  });
});
