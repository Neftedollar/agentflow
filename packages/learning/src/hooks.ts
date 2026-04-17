import type {
  RunnerSpawnArgs,
  RunnerSpawnResult,
  WorkflowHooks,
} from "@ageflow/core";
import type { SkillStore, TraceStore } from "./interfaces.js";
import type { ExecutionTrace, LearningConfig, TaskTrace } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { runReflection } from "./workflows/reflection.js";

export interface CreateLearningHooksOptions {
  readonly skillStore: SkillStore;
  readonly traceStore: TraceStore;
  readonly workflowName: string;
  readonly config?: Partial<LearningConfig>;
  /**
   * DAG structure passed to runReflection when auto-reflection fires.
   * Required for reflectEvery scheduling; if omitted, auto-reflection is
   * silently skipped even when reflectEvery is set.
   */
  readonly dagStructure?: Record<string, readonly string[]>;
}

export function createLearningHooks(
  opts: CreateLearningHooksOptions,
): WorkflowHooks {
  const config = { ...DEFAULT_CONFIG, ...opts.config };
  const { skillStore, traceStore, workflowName, dagStructure } = opts;

  // Per-run state (reset on each workflow execution)
  let taskTraces: TaskTrace[] = [];
  let runStartTime = Date.now();
  let runCount = 0;
  let isFirstTaskOfRun = true;
  // #172: captured from onWorkflowStart, threaded into ExecutionTrace
  let capturedWorkflowInput: unknown = null;

  // Cache active skills per task (populated async on onTaskStart).
  // Stores Promises so getSystemPromptPrefix can await the result —
  // eliminates the race condition where the store query hadn't resolved yet.
  const skillCache = new Map<string, Promise<string | undefined>>();

  // Resolved skill content per task — populated by the promise .then() handler.
  // Used by onTaskComplete (which is sync) to check whether a skill was applied.
  const resolvedSkillContent = new Map<string, string | undefined>();

  // #173: runner brand per task — populated in onTaskStart, read in onTaskComplete/onTaskError
  const taskRunnerMap = new Map<string, string>();

  // #169: spawn args/result per task — populated by onTaskSpawnArgs/onTaskSpawnResult
  const taskSpawnArgsMap = new Map<string, RunnerSpawnArgs>();
  const taskSpawnResultMap = new Map<string, RunnerSpawnResult>();

  return {
    // #172: capture workflow input once at run start
    onWorkflowStart(input) {
      capturedWorkflowInput = input;
    },

    onTaskStart(taskName, runner) {
      if (isFirstTaskOfRun) {
        // Reset state for the new run
        taskTraces = [];
        runStartTime = Date.now();
        skillCache.clear();
        resolvedSkillContent.clear();
        taskRunnerMap.clear();
        taskSpawnArgsMap.clear();
        taskSpawnResultMap.clear();
        isFirstTaskOfRun = false;
      }

      // #173: store runner brand for this task
      taskRunnerMap.set(taskName, runner);

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

    // #169: capture resolved spawn args before each runner.spawn() call
    onTaskSpawnArgs(taskName, args) {
      taskSpawnArgsMap.set(taskName, args);
    },

    // #169: capture raw spawn result after each runner.spawn() returns
    onTaskSpawnResult(taskName, result) {
      taskSpawnResultMap.set(taskName, result);
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

      // #173: read runner brand captured in onTaskStart
      const agentRunner = taskRunnerMap.get(taskName) ?? "";

      // #169: retrieve captured spawn args/result for this task
      const spawnArgs = taskSpawnArgsMap.get(taskName);
      const spawnResult = taskSpawnResultMap.get(taskName);

      taskTraces.push({
        taskName,
        agentRunner,
        prompt: metrics.promptSent ?? "",
        output: typeof output === "string" ? output : JSON.stringify(output),
        parsedOutput: output,
        success: true,
        skillsApplied: appliedSkills,
        tokensIn: metrics.tokensIn,
        tokensOut: metrics.tokensOut,
        durationMs: metrics.latencyMs,
        retryCount: metrics.retries,
        ...(spawnArgs !== undefined ? { spawnArgs } : {}),
        ...(spawnResult !== undefined ? { spawnResult } : {}),
      });

      // Mark next onTaskStart as still part of this run
      // (isFirstTaskOfRun stays false until onWorkflowComplete resets it)
    },

    onTaskError(taskName, error, attempt) {
      // #173: read runner brand captured in onTaskStart
      const agentRunner = taskRunnerMap.get(taskName) ?? "";

      taskTraces.push({
        taskName,
        agentRunner,
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
        // #172: use workflow input captured from onWorkflowStart
        workflowInput: capturedWorkflowInput,
        workflowOutput: result,
        feedback: [],
      };

      await traceStore.saveTrace(trace);

      // Reset for next run
      isFirstTaskOfRun = true;
      capturedWorkflowInput = null;

      // Auto-reflection scheduler — Phase 6 implementation of reflectEvery config.
      // Fires runReflection() non-blocking (fire-and-forget) when the condition is met.
      // Errors are logged but never propagate to avoid blocking workflow completion.
      if (dagStructure !== undefined) {
        const { reflectEvery } = config;
        let shouldReflect = false;

        if (reflectEvery === "always") {
          shouldReflect = true;
        } else if (typeof reflectEvery === "number" && reflectEvery >= 1) {
          shouldReflect = runCount % reflectEvery === 0;
        }
        // "on-failure" and "on-feedback" are intentionally left for future phases.

        if (shouldReflect) {
          runReflection({
            currentTrace: trace,
            dagStructure,
            skillStore,
            traceStore,
          }).catch((err: unknown) => {
            console.warn("[learning] auto-reflection failed", err);
          });
        }
      }
    },
  };
}
