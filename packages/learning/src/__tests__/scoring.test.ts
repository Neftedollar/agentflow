import { describe, expect, it } from "vitest";
import { shouldRollback, updateScore } from "../scoring.js";
import { DEFAULT_THRESHOLDS } from "../types.js";

describe("updateScore", () => {
  it("applies EMA with default alpha 0.3", () => {
    // new = 0.3 * 1.0 + 0.7 * 0.5 = 0.3 + 0.35 = 0.65
    const result = updateScore(0.5, 1.0, false, DEFAULT_THRESHOLDS);
    expect(result).toBeCloseTo(0.65, 10);
  });

  it("uses higher alpha 0.5 for delayed feedback", () => {
    // new = 0.5 * 1.0 + 0.5 * 0.5 = 0.5 + 0.25 = 0.75
    const result = updateScore(0.5, 1.0, true, DEFAULT_THRESHOLDS);
    expect(result).toBeCloseTo(0.75, 10);
  });

  it("clamps result to 0 when EMA would go below 0", () => {
    // new = 0.3 * 0 + 0.7 * 0 = 0 — stays at 0
    const result = updateScore(0, 0, false, DEFAULT_THRESHOLDS);
    expect(result).toBe(0);
  });

  it("clamps result to 1 when EMA would exceed 1", () => {
    // new = 0.3 * 1 + 0.7 * 1 = 1 — stays at 1
    const result = updateScore(1, 1, false, DEFAULT_THRESHOLDS);
    expect(result).toBe(1);
  });

  it("clamps to [0, 1] even with edge signals", () => {
    // Force a scenario: currentScore=0, signal=0 -> 0 (min clamp path)
    // currentScore=1, signal=1 -> 1 (max clamp path)
    expect(updateScore(0, 0, true, DEFAULT_THRESHOLDS)).toBe(0);
    expect(updateScore(1, 1, true, DEFAULT_THRESHOLDS)).toBe(1);
  });
});

describe("shouldRollback", () => {
  it("returns false when runCount < minRunsBeforeRollback (3)", () => {
    // minRunsBeforeRollback = 3, runCount = 2 → false
    const result = shouldRollback(0.3, 0.9, 2, DEFAULT_THRESHOLDS);
    expect(result).toBe(false);
  });

  it("returns false when score is within rollback margin (0.15)", () => {
    // bestScore=0.8, currentScore=0.7, diff=0.1 < margin=0.15 → false
    const result = shouldRollback(0.7, 0.8, 5, DEFAULT_THRESHOLDS);
    expect(result).toBe(false);
  });

  it("returns false when score equals best minus margin exactly", () => {
    // bestScore=0.8, currentScore=0.65, diff=0.15 — not strictly below → false
    const result = shouldRollback(0.65, 0.8, 5, DEFAULT_THRESHOLDS);
    expect(result).toBe(false);
  });

  it("returns true when score drops below best minus margin", () => {
    // bestScore=0.8, currentScore=0.6, diff=0.2 > margin=0.15 → true
    const result = shouldRollback(0.6, 0.8, 5, DEFAULT_THRESHOLDS);
    expect(result).toBe(true);
  });

  it("returns false when runCount equals minRunsBeforeRollback - 1", () => {
    const result = shouldRollback(0.1, 0.9, 2, DEFAULT_THRESHOLDS);
    expect(result).toBe(false);
  });

  it("returns true with runCount exactly at minRunsBeforeRollback and bad score", () => {
    // runCount=3 >= 3, score=0.5, best=0.8, diff=0.3 > 0.15 → true
    const result = shouldRollback(0.5, 0.8, 3, DEFAULT_THRESHOLDS);
    expect(result).toBe(true);
  });
});
