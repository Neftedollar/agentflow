import { z } from "zod";

// ─── Feedback ─────────────────────────────────────────────────────────────────

export const FeedbackSchema = z.object({
  rating: z.enum(["positive", "negative", "mixed"]),
  comment: z.string().optional(),
  source: z.enum(["human", "ci", "monitoring"]),
  timestamp: z.string().datetime(),
});

export type Feedback = z.infer<typeof FeedbackSchema>;

// ─── TaskTrace ────────────────────────────────────────────────────────────────

export const TaskTraceSchema = z.object({
  taskName: z.string(),
  agentRunner: z.string(),
  prompt: z.string(),
  output: z.string(),
  parsedOutput: z.unknown(),
  success: z.boolean(),
  skillsApplied: z.array(z.string()),
  tokensIn: z.number(),
  tokensOut: z.number(),
  durationMs: z.number(),
  retryCount: z.number(),
  /**
   * The resolved spawn args passed to runner.spawn() — captured via
   * onTaskSpawnArgs. Includes the full prompt, tool list, MCP servers, etc.
   * Present only when the onTaskSpawnArgs hook fired for this task.
   */
  spawnArgs: z.unknown().optional(),
  /**
   * The raw runner.spawn() result — captured via onTaskSpawnResult.
   * Includes stdout, sessionHandle, token counts and tool-call trail.
   * Present only when the onTaskSpawnResult hook fired for this task.
   */
  spawnResult: z.unknown().optional(),
});

export type TaskTrace = z.infer<typeof TaskTraceSchema>;

// ─── ExecutionTrace ───────────────────────────────────────────────────────────

export const ExecutionTraceSchema = z.object({
  id: z.string().uuid(),
  workflowName: z.string(),
  runAt: z.string().datetime(),
  success: z.boolean(),
  totalDurationMs: z.number(),
  taskTraces: z.array(TaskTraceSchema),
  workflowInput: z.unknown(),
  workflowOutput: z.unknown(),
  feedback: z.array(FeedbackSchema),
});

export type ExecutionTrace = z.infer<typeof ExecutionTraceSchema>;

// ─── SkillRecord ──────────────────────────────────────────────────────────────

export const SkillRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  targetAgent: z.string(),
  targetWorkflow: z.string().optional(),
  version: z.number().int().nonnegative(),
  parentId: z.string().uuid().optional(),
  status: z.enum(["active", "retired"]),
  score: z.number().min(0).max(1),
  runCount: z.number().int().nonnegative(),
  bestInLineage: z.boolean(),
  createdAt: z.string().datetime(),
  /**
   * Optional embedding vector for semantic search via sqlite-vec.
   * Produced externally (e.g. by the reflection workflow) and stored here.
   * When present the SQLite store uses vec0 KNN search; otherwise
   * falls back to FTS5 keyword search.
   */
  embedding: z.instanceof(Float32Array).optional(),
});

export type SkillRecord = z.infer<typeof SkillRecordSchema>;

// ─── Query types ──────────────────────────────────────────────────────────────

export interface ScoredSkill {
  readonly skill: SkillRecord;
  /** Retrieval relevance score (0-1), NOT quality score. */
  readonly relevance: number;
}

export interface TraceFilter {
  readonly workflowName?: string;
  readonly since?: string;
  readonly limit?: number;
  readonly hasFeedback?: boolean;
}

// ─── Learning config ──────────────────────────────────────────────────────────

export interface LearningThresholds {
  /** Score below which reflection triggers skill rewrite. Default: 0.7 */
  readonly reflectionThreshold: number;
  /** Score drop from best-in-lineage that triggers rollback. Default: 0.15 */
  readonly rollbackMargin: number;
  /** Minimum runs before rollback decision. Default: 3 */
  readonly minRunsBeforeRollback: number;
  /** EMA smoothing factor. Default: 0.3 */
  readonly emaAlpha: number;
  /** EMA alpha when delayed feedback contradicts immediate. Default: 0.5 */
  readonly feedbackAlpha: number;
}

export const DEFAULT_THRESHOLDS: LearningThresholds = {
  reflectionThreshold: 0.7,
  rollbackMargin: 0.15,
  minRunsBeforeRollback: 3,
  emaAlpha: 0.3,
  feedbackAlpha: 0.5,
};

export type ReflectEvery = "always" | "on-failure" | "on-feedback" | number;

export interface LearningConfig {
  readonly strategy: "autonomous" | "hitl";
  readonly reflectEvery: ReflectEvery;
  readonly thresholds: LearningThresholds;
}

export const DEFAULT_CONFIG: LearningConfig = {
  strategy: "autonomous",
  reflectEvery: "always",
  thresholds: DEFAULT_THRESHOLDS,
};
