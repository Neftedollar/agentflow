import type { SkillStore } from "../interfaces.js";
import { shouldRollback } from "../scoring.js";
import type { LearningThresholds, SkillRecord } from "../types.js";
import { DEFAULT_THRESHOLDS } from "../types.js";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface RollbackAction {
  type: "rollback";
  retiredSkillId: string;
  retiredSkillName: string;
  activatedSkillId: string;
  activatedSkillName: string;
  reason: string;
}

export interface NoOpAction {
  type: "noop";
  skillId: string;
  skillName: string;
  reason: string;
}

export type PromotionAction = RollbackAction | NoOpAction;

export interface PromotionSummary {
  skillsChecked: number;
  rollbacks: number;
  noops: number;
  actions: PromotionAction[];
}

// ─── runPromotion() ───────────────────────────────────────────────────────────

export interface PromotionInput {
  skillStore: SkillStore;
  thresholds?: LearningThresholds;
}

/**
 * Deterministic promotion/rollback cycle — no LLM calls.
 *
 * Algorithm:
 *   1. Read all active skills from the store.
 *   2. For each active skill, find the best-in-lineage skill.
 *   3. If shouldRollback(current, best, runCount, thresholds) → retire current,
 *      activate best-in-lineage.
 *   4. Return a summary of all actions taken.
 *
 * Retired skills are skipped entirely.
 */
export async function runPromotion(
  input: PromotionInput,
): Promise<PromotionSummary> {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

  // 1. Read all skills, filter to active only
  const allSkills = await input.skillStore.list();
  const activeSkills = allSkills.filter((s) => s.status === "active");

  const actions: PromotionAction[] = [];

  for (const skill of activeSkills) {
    // 2. Find best-in-lineage
    const bestInLineage = await input.skillStore.getBestInLineage(skill.id);

    // If there's no ancestor or this skill IS the best, use its own score as
    // the "best" reference.
    const bestScore = bestInLineage ? bestInLineage.score : skill.score;

    // 3. Check rollback condition
    const rollback = shouldRollback(
      skill.score,
      bestScore,
      skill.runCount,
      thresholds,
    );

    if (rollback && bestInLineage && bestInLineage.id !== skill.id) {
      // Retire current, re-activate best-in-lineage
      await input.skillStore.retire(skill.id);
      await input.skillStore.save({
        ...bestInLineage,
        status: "active",
      });

      actions.push({
        type: "rollback",
        retiredSkillId: skill.id,
        retiredSkillName: skill.name,
        activatedSkillId: bestInLineage.id,
        activatedSkillName: bestInLineage.name,
        reason: `Score ${skill.score.toFixed(3)} dropped below best-in-lineage ${bestScore.toFixed(3)} by more than margin ${thresholds.rollbackMargin} after ${skill.runCount} runs`,
      });
    } else {
      let reason: string;
      if (skill.runCount < thresholds.minRunsBeforeRollback) {
        reason = `Only ${skill.runCount} run(s) — minimum ${thresholds.minRunsBeforeRollback} required before rollback decision`;
      } else if (!bestInLineage || bestInLineage.id === skill.id) {
        reason = "This skill is the best in its lineage — no rollback possible";
      } else {
        reason = `Score ${skill.score.toFixed(3)} within acceptable margin of best ${bestScore.toFixed(3)} (margin: ${thresholds.rollbackMargin})`;
      }

      actions.push({
        type: "noop",
        skillId: skill.id,
        skillName: skill.name,
        reason,
      });
    }
  }

  const rollbacks = actions.filter((a) => a.type === "rollback").length;
  const noops = actions.filter((a) => a.type === "noop").length;

  return {
    skillsChecked: activeSkills.length,
    rollbacks,
    noops,
    actions,
  };
}
