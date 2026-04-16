import type { TasksMap } from "@ageflow/core";
import type { SessionManager } from "./session-manager.js";

/**
 * Internal function type for running batches of tasks.
 * Shared between WorkflowExecutor and LoopExecutor to avoid circular imports.
 *
 * sessionManager override lets LoopExecutor supply a per-loop local manager
 * so inner loop tasks get proper session grouping and handle tracking (C1 fix).
 */
export type RunBatchesFn = (
  tasks: TasksMap,
  ctx: Record<string, CtxEntry>,
  sessionManager?: SessionManager,
) => Promise<Record<string, CtxEntry>>;

/**
 * Internal context entry for a completed task.
 */
export interface CtxEntry {
  output: unknown;
  _source: "agent" | "loop";
}
