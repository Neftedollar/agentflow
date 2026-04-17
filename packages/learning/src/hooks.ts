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

  // Cache active skills per task (populated async on onTaskStart)
  // Maps taskName -> skill content string or null (null = no skill found)
  const skillCache = new Map<string, string | null>();

  return {
    onTaskStart(taskName) {
      if (isFirstTaskOfRun) {
        // Reset state for the new run
        taskTraces = [];
        runStartTime = Date.now();
        skillCache.clear();
        isFirstTaskOfRun = false;
      }

      // Async pre-populate cache — fire and don't await (sync hook)
      // The cache will be ready by the time getSystemPromptPrefix is called
      // if there's any async gap (e.g. executor awaits before spawn).
      // We store a promise so repeated calls don't double-fetch.
      if (!skillCache.has(taskName)) {
        // Mark as in-flight with undefined to prevent double calls
        skillStore
          .getActiveForTask(taskName, workflowName)
          .then((skill) => {
            skillCache.set(taskName, skill?.content ?? null);
          })
          .catch(() => {
            skillCache.set(taskName, null);
          });
      }
    },

    getSystemPromptPrefix(taskName) {
      // Return cached value (sync). May be undefined if cache not yet populated.
      const cached = skillCache.get(taskName);
      if (cached === null) return undefined; // explicitly no skill
      return cached ?? undefined; // undefined if not yet cached
    },

    onTaskComplete(taskName, output, metrics) {
      const appliedSkills: string[] = [];
      const cachedSkill = skillCache.get(taskName);
      if (cachedSkill) appliedSkills.push(taskName);

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
