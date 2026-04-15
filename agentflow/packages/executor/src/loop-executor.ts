import type { LoopDef, TasksMap } from "@agentflow/core";
import { LoopMaxIterationsError } from "@agentflow/core";
import { SessionManager } from "./session-manager.js";
import type { CtxEntry, RunBatchesFn } from "./types-internal.js";

export class LoopExecutor {
  constructor(private readonly runBatches: RunBatchesFn) {}

  /**
   * Run a loop task iteratively.
   *
   * D3 contract:
   * - context: "persistent" — each iteration reuses session handles from the
   *   previous iteration (per-task-slot). A single local SessionManager is
   *   created for the loop and accumulates handles across iterations.
   * - context: "fresh" (default) — each iteration starts with a new
   *   SessionManager, so no handles carry over between iterations.
   * - until(ctx) is evaluated after each iteration; if true, loop ends.
   * - feedback: last iteration's output is merged into next iteration's ctx.
   * - LoopMaxIterationsError when iterations reach loop.max without until() returning true.
   */
  async run(
    loopDef: LoopDef<TasksMap>,
    outerCtx: Record<string, CtxEntry>,
    taskName: string,
  ): Promise<unknown> {
    const isPersistent = loopDef.context === "persistent";

    // For persistent context: one SessionManager lives across all iterations so
    // handles naturally accumulate. For fresh: a new one is created each time.
    const persistentSM = isPersistent
      ? new SessionManager(loopDef.tasks)
      : undefined;

    let lastOutput: unknown = undefined;

    for (let iteration = 0; iteration < loopDef.max; iteration++) {
      // Build inner context from outerCtx
      const innerCtx: Record<string, CtxEntry> = { ...outerCtx };

      // Add feedback from last iteration (if applicable)
      if (iteration > 0 && lastOutput !== undefined) {
        innerCtx.__loop_feedback__ = { output: lastOutput, _source: "loop" };
      }

      // Select the session manager for this iteration (C1 fix: always loop-local)
      const sm = persistentSM ?? new SessionManager(loopDef.tasks);

      // Resolve input for this iteration
      let resolvedInput: unknown = undefined;
      if (loopDef.input !== undefined) {
        if (typeof loopDef.input === "function") {
          const inputCtx: Record<string, unknown> = {};
          for (const [key, entry] of Object.entries(innerCtx)) {
            if (key !== "__loop_feedback__") {
              inputCtx[key] = { output: entry.output };
            }
          }
          if (iteration > 0 && lastOutput !== undefined) {
            inputCtx.feedback = lastOutput;
          }
          resolvedInput = (loopDef.input as (ctx: unknown) => unknown)(
            inputCtx,
          );
        } else {
          resolvedInput = loopDef.input;
        }
      }

      // Merge resolved input into inner ctx if it's an object
      if (
        resolvedInput !== undefined &&
        typeof resolvedInput === "object" &&
        resolvedInput !== null
      ) {
        for (const [k, v] of Object.entries(
          resolvedInput as Record<string, unknown>,
        )) {
          innerCtx[k] = { output: v, _source: "loop" };
        }
      }

      // Run all batches of inner tasks, using the loop-local session manager
      const results = await this.runBatches(loopDef.tasks, innerCtx, sm);
      lastOutput = results;

      // Check exit condition
      if (loopDef.until(results)) {
        return results;
      }
    }

    throw new LoopMaxIterationsError(taskName, loopDef.max);
  }
}
