import { BudgetExceededError } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../budget-tracker.js";

describe("BudgetTracker", () => {
  // ─── costFor ───────────────────────────────────────────────────────────────

  describe("costFor", () => {
    it("calculates correctly for known model claude-sonnet-4-6", () => {
      const tracker = new BudgetTracker();
      // 1M input tokens at $3.00 + 1M output tokens at $15.00 = $18.00
      const cost = tracker.costFor("claude-sonnet-4-6", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(18.0);
    });

    it("calculates correctly for claude-opus-4-6", () => {
      const tracker = new BudgetTracker();
      // 1M input at $15.00 + 1M output at $75.00 = $90.00
      const cost = tracker.costFor("claude-opus-4-6", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(90.0);
    });

    it("calculates correctly for claude-haiku-4-5", () => {
      const tracker = new BudgetTracker();
      // 1M input at $0.80 + 1M output at $4.00 = $4.80
      const cost = tracker.costFor("claude-haiku-4-5", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(4.8);
    });

    it("calculates for small token counts", () => {
      const tracker = new BudgetTracker();
      // 1000 input tokens at $3.00/M = $0.003, 500 output at $15.00/M = $0.0075
      const cost = tracker.costFor("claude-sonnet-4-6", 1_000, 500);
      expect(cost).toBeCloseTo(0.003 + 0.0075);
    });

    it("falls back to _default for unknown model", () => {
      const tracker = new BudgetTracker();
      // _default = $3.00/M input, $15.00/M output (same as sonnet)
      const defaultCost = tracker.costFor(
        "unknown-model-xyz",
        1_000_000,
        1_000_000,
      );
      const sonnetCost = tracker.costFor(
        "claude-sonnet-4-6",
        1_000_000,
        1_000_000,
      );
      expect(defaultCost).toBeCloseTo(sonnetCost);
    });

    it("returns 0 for zero tokens", () => {
      const tracker = new BudgetTracker();
      expect(tracker.costFor("claude-sonnet-4-6", 0, 0)).toBe(0);
    });
  });

  // ─── addCost + total ───────────────────────────────────────────────────────

  describe("addCost and total", () => {
    it("starts at 0", () => {
      const tracker = new BudgetTracker();
      expect(tracker.total).toBe(0);
    });

    it("accumulates cost across multiple addCost calls", () => {
      const tracker = new BudgetTracker();
      tracker.addCost("claude-sonnet-4-6", 1_000_000, 0);
      tracker.addCost("claude-sonnet-4-6", 1_000_000, 0);
      // 2 × 1M input tokens at $3.00/M = $6.00
      expect(tracker.total).toBeCloseTo(6.0);
    });

    it("accumulates costs from different models", () => {
      const tracker = new BudgetTracker();
      tracker.addCost("claude-sonnet-4-6", 1_000_000, 0); // $3.00
      tracker.addCost("claude-opus-4-6", 1_000_000, 0); // $15.00
      expect(tracker.total).toBeCloseTo(18.0);
    });
  });

  // ─── checkBudget ──────────────────────────────────────────────────────────

  describe("checkBudget", () => {
    it("onExceed 'halt': throws BudgetExceededError when over limit", () => {
      const tracker = new BudgetTracker();
      tracker.addCost("claude-sonnet-4-6", 1_000_000, 1_000_000); // $18.00
      expect(() =>
        tracker.checkBudget({ maxCost: 10.0, onExceed: "halt" }),
      ).toThrow(BudgetExceededError);
    });

    it("onExceed 'halt': throws with correct maxCost and actualCost", () => {
      const tracker = new BudgetTracker();
      tracker.addCost("claude-sonnet-4-6", 1_000_000, 1_000_000); // $18.00
      let caught: BudgetExceededError | undefined;
      try {
        tracker.checkBudget({ maxCost: 10.0, onExceed: "halt" });
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          caught = e;
        }
      }
      expect(caught?.maxCost).toBe(10.0);
      expect(caught?.actualCost).toBeGreaterThan(10.0);
    });

    it("onExceed 'halt': does NOT throw when under limit", () => {
      const tracker = new BudgetTracker();
      tracker.addCost("claude-haiku-4-5", 100, 100); // very small cost
      expect(() =>
        tracker.checkBudget({ maxCost: 10.0, onExceed: "halt" }),
      ).not.toThrow();
    });

    it("onExceed 'warn': does NOT throw even when over limit", () => {
      const tracker = new BudgetTracker();
      tracker.addCost("claude-sonnet-4-6", 1_000_000, 1_000_000); // $18.00
      expect(() =>
        tracker.checkBudget({ maxCost: 1.0, onExceed: "warn" }),
      ).not.toThrow();
    });

    it("onExceed 'halt': does not throw when cost equals limit exactly", () => {
      const tracker = new BudgetTracker();
      // Manually set to exactly the limit via addCost (tricky to hit exactly, use 0-cost)
      // Cost = 0, limit = 0 → 0 > 0 is false → no throw
      expect(() =>
        tracker.checkBudget({ maxCost: 0, onExceed: "halt" }),
      ).not.toThrow();
    });
  });

  // ─── exceeded ─────────────────────────────────────────────────────────────

  describe("exceeded", () => {
    it("returns false when under limit", () => {
      const tracker = new BudgetTracker();
      tracker.addCost("claude-haiku-4-5", 100, 100);
      expect(tracker.exceeded({ maxCost: 100.0, onExceed: "halt" })).toBe(
        false,
      );
    });

    it("returns true when over limit", () => {
      const tracker = new BudgetTracker();
      tracker.addCost("claude-sonnet-4-6", 1_000_000, 1_000_000); // $18.00
      expect(tracker.exceeded({ maxCost: 5.0, onExceed: "halt" })).toBe(true);
    });

    it("returns false when cost equals limit exactly (strict greater-than)", () => {
      // total = 0, maxCost = 0 → 0 > 0 = false
      const tracker = new BudgetTracker();
      expect(tracker.exceeded({ maxCost: 0, onExceed: "halt" })).toBe(false);
    });
  });
});
