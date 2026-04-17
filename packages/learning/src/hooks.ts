import type { WorkflowHooks } from "@ageflow/core";
import type { SkillStore, TraceStore } from "./interfaces.js";
import type { ExecutionTrace, LearningConfig, TaskTrace } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export interface CreateLearningHooksOptions {
  readonly skillStore: SkillStore;
  readonly traceStore: TraceStore;
  readonly workflowName: string;
  readonly config?: Partial<LearningConfig>;
}

export function createLearningHooks(
  opts: CreateLearningHooksOptions,
): WorkflowHooks {
  const _config = { ...DEFAULT_CONFIG, ...opts.config }; // reserved for Phase 6
  const { skillStore, traceStore, workflowName } = opts;

  // Per-run state (reset on each workflow execution)
  let taskTraces: TaskTrace[] = [];
  let runStartTime = Date.now();
  let runCount = 0;
  let isFirstTaskOfRun = true;

  // Cache active skills per task (populated async on onTaskStart).
  // Stores Promises so getSystemPromptPrefix can await the result —
  // eliminates the race condition where the store query hadn't resolved yet.
  const skillCache = new Map<string, Promise<string | undefined>>();

  // Resolved skill content per task — populated by the promise .then() handler.
  // Used by onTaskComplete (which is sync) to check whether a skill was applied.
  const resolvedSkillContent = new Map<string, string | undefined>();

  return {
    onTaskStart(taskName) {
      if (isFirstTaskOfRun) {
        // Reset state for the new run
        taskTraces = [];
        runStartTime = Date.now();
        skillCache.clear();
        resolvedSkillContent.clear();
        isFirstTaskOfRun = false;
      }

      // Store a Promise so getSystemPromptPrefix can await it.
      // Repeated calls for the same taskName reuse the same promise.
      if (!skillCache.has(taskName)) {
        const promise = skillStore
          .getActiveForTask(taskName, workflowName)
          .then((skill) => skill?.content)
          .catch(() => undefined);

        // Also populate the resolved map so onTaskComplete can read it
        // synchronously after the promise has settled.
        promise.then((content) => {
          resolvedSkillContent.set(taskName, content);
        });

        skillCache.set(taskName, promise);
      }
    },

    async getSystemPromptPrefix(taskName) {
      // Await the pending promise so skills are never silently dropped.
      const pending = skillCache.get(taskName);
      if (pending === undefined) return undefined;
      return pending;
    },

    onTaskComplete(taskName, output, metrics) {
      const appliedSkills: string[] = [];
      // Use the resolved map (populated after the promise settles).
      // By the time onTaskComplete fires, getSystemPromptPrefix has already
      // been awaited by the executor, so the resolved value is always present.
      const resolvedContent = resolvedSkillContent.get(taskName);
      if (resolvedContent) appliedSkills.push(taskName);

      taskTraces.push({
        taskName,
        agentRunner: "",
        prompt: metrics.promptSent ?? "",
        output: typeof output === "string" ? output : JSON.stringify(output),
        parsedOutput: output,
        success: true,
        skillsApplied: appliedSkills,
        tokensIn: metrics.tokensIn,
        tokensOut: metrics.tokensOut,
        durationMs: metrics.latencyMs,
        retryCount: metrics.retries,
      });

      // Mark next onTaskStart as still part of this run
      // (isFirstTaskOfRun stays false until onWorkflowComplete resets it)
    },

    onTaskError(taskName, error, attempt) {
      taskTraces.push({
        taskName,
        agentRunner: "",
        prompt: "",
        output: error.message,
        parsedOutput: null,
        success: false,
        skillsApplied: [],
        tokensIn: 0,
        tokensOut: 0,
        durationMs: 0,
        retryCount: attempt,
      });
    },

    async onWorkflowComplete(result, summary) {
      runCount++;
      const trace: ExecutionTrace = {
        id: crypto.randomUUID(),
        workflowName,
        runAt: new Date().toISOString(),
        success: summary.taskCount > 0 && taskTraces.every((t) => t.success),
        totalDurationMs: Date.now() - runStartTime,
        taskTraces,
        workflowInput: null,
        workflowOutput: result,
        feedback: [],
      };

      await traceStore.saveTrace(trace);

      // Reset for next run
      isFirstTaskOfRun = true;

      // TODO Phase 6: trigger reflectionWorkflow here based on config.reflectEvery
    },
  };
}
