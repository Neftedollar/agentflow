import type { LearningThresholds } from "./types.js";

/** EMA score update. Signal is 0-1. Returns clamped [0,1]. */
export function updateScore(
  currentScore: number,
  signal: number,
  isDelayedFeedback: boolean,
  thresholds: LearningThresholds,
): number {
  const alpha = isDelayedFeedback
    ? thresholds.feedbackAlpha
    : thresholds.emaAlpha;
  const raw = alpha * signal + (1 - alpha) * currentScore;
  return Math.max(0, Math.min(1, raw));
}

/** Should we rollback to a better version? */
export function shouldRollback(
  currentScore: number,
  bestScore: number,
  runCount: number,
  thresholds: LearningThresholds,
): boolean {
  if (runCount < thresholds.minRunsBeforeRollback) return false;
  return currentScore < bestScore - thresholds.rollbackMargin;
}
