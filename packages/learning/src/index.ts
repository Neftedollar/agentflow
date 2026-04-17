// Types
export type {
  ExecutionTrace,
  Feedback,
  LearningConfig,
  LearningThresholds,
  ReflectEvery,
  ScoredSkill,
  SkillRecord,
  TaskTrace,
  TraceFilter,
} from "./types.js";

export {
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
  ExecutionTraceSchema,
  FeedbackSchema,
  SkillRecordSchema,
  TaskTraceSchema,
} from "./types.js";

// Interfaces
export type { SkillStore, TraceStore } from "./interfaces.js";

// Scoring
export { shouldRollback, updateScore } from "./scoring.js";

// Hooks
export { createLearningHooks } from "./hooks.js";
export type { CreateLearningHooksOptions } from "./hooks.js";

// Workflows
export {
  creditAssignmentAgent,
  generateSkillDraftsAgent,
  reflectionWorkflow,
  runReflection,
  CreditResultSchema,
  SkillDraftSchema,
  GenerateSkillDraftsOutputSchema,
} from "./workflows/reflection.js";
export type {
  CreditResult,
  SkillDraft,
  GenerateSkillDraftsOutput,
  ReflectionInput,
  ReflectionSummary,
} from "./workflows/reflection.js";

export {
  hypotheticalComparisonAgent,
  evaluationWorkflow,
  runEvaluation,
  HypotheticalVerdictSchema,
} from "./workflows/evaluation.js";
export type {
  HypotheticalVerdict,
  EvaluationResult,
  EvaluationInput,
  EvaluationSummary,
} from "./workflows/evaluation.js";

export { runPromotion } from "./workflows/promotion.js";
export type {
  PromotionAction,
  PromotionSummary,
  PromotionInput,
  RollbackAction,
  NoOpAction,
} from "./workflows/promotion.js";
