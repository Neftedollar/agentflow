import {
  registerRunner,
  getRunners,
  unregisterRunner,
} from "@agentflow/core";
import type { Runner, RunnerSpawnArgs, TasksMap, WorkflowDef, WorkflowHooks } from "@agentflow/core";
import { WorkflowExecutor } from "@agentflow/executor";
import type { WorkflowResult } from "@agentflow/executor";

// ─── Types ─────────────────────────────────────────────────────────────────────

type MockResponse = Record<string, unknown> | { throws: Error };

export interface TaskStats {
  /** Total number of spawn calls for this task (includes retried attempts). */
  callCount: number;
  /**
   * Number of retried attempts — callCount minus the number of successful outputs.
   * Only meaningful if the task eventually succeeded.
   */
  retryCount: number;
  /** All outputs that produced a successful (non-throwing) response. */
  outputs: unknown[];
}

export interface TestHarness {
  /**
   * Register a mock response for a named task.
   *
   * - Single object: always returned (repeated).
   * - Array: returned sequentially; last element repeats once exhausted.
   * - `{ throws: Error }`: simulate a subprocess / validation failure.
   */
  mockAgent(
    taskName: string,
    response:
      | Record<string, unknown>
      | Record<string, unknown>[]
      | { throws: Error },
  ): void;

  /** Run the workflow with mocked runners. Returns the full WorkflowResult. */
  run(input?: unknown): Promise<WorkflowResult<TasksMap>>;

  /** Inspect call/retry/output statistics for a named task after run(). */
  getTask(name: string): TaskStats;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively collect all unique runner names referenced in a TasksMap.
 * Handles LoopDef by recursing into their inner tasks.
 */
function collectRunnerNames(tasks: TasksMap): Set<string> {
  const names = new Set<string>();
  for (const task of Object.values(tasks)) {
    if (task !== null && typeof task === "object" && "kind" in task) {
      // LoopDef — recurse
      const loopTask = task as { kind: string; tasks: TasksMap };
      for (const name of collectRunnerNames(loopTask.tasks)) {
        names.add(name);
      }
    } else {
      // TaskDef
      const taskDef = task as { agent: { runner: string } };
      names.add(taskDef.agent.runner);
    }
  }
  return names;
}

// ─── Main export ───────────────────────────────────────────────────────────────

/**
 * Create a test harness for a workflow.
 *
 * The harness patches the global runner registry for the duration of `run()`,
 * replacing all referenced runners with a `MockRunner` that returns predetermined
 * responses. The registry is fully restored after `run()` completes (or throws).
 *
 * @example
 * const harness = createTestHarness(myWorkflow);
 * harness.mockAgent("analyze", { issues: ["lint error"] });
 * const result = await harness.run();
 * expect(result.outputs["analyze"]).toEqual({ issues: ["lint error"] });
 */
export function createTestHarness(workflow: WorkflowDef): TestHarness {
  const mocks = new Map<string, MockResponse[]>();
  const stats = new Map<string, { callCount: number; successCount: number; outputs: unknown[] }>();

  // Shared mutable ref — updated by onTaskStart hook so MockRunner.spawn() knows
  // which task is currently executing without needing to parse the prompt.
  const currentTask = { value: "" };

  const mockRunner: Runner = {
    async validate(): Promise<{ ok: boolean; version: string }> {
      return { ok: true, version: "mock-1.0.0" };
    },

    async spawn(_args: RunnerSpawnArgs) {
      const taskName = currentTask.value;

      // Initialise stats entry on first call
      if (!stats.has(taskName)) {
        stats.set(taskName, { callCount: 0, successCount: 0, outputs: [] });
      }
      const s = stats.get(taskName)!;
      s.callCount++;

      // Resolve response from mock queue (last element repeats)
      const queue = mocks.get(taskName) ?? [{}];
      const idx = Math.min(s.callCount - 1, queue.length - 1);
      const resp = queue[idx]!;

      if ("throws" in resp) {
        throw resp.throws;
      }

      s.successCount++;
      s.outputs.push(resp);

      return {
        stdout: JSON.stringify(resp),
        sessionHandle: `mock-${taskName}`,
        tokensIn: 10,
        tokensOut: 20,
      };
    },
  };

  return {
    mockAgent(
      taskName: string,
      response:
        | Record<string, unknown>
        | Record<string, unknown>[]
        | { throws: Error },
    ): void {
      const arr = Array.isArray(response) ? response : [response];
      mocks.set(taskName, arr as MockResponse[]);
    },

    async run(input?: unknown): Promise<WorkflowResult<TasksMap>> {
      // Snapshot registry state before patching
      const savedEntries = [...getRunners().entries()];
      const runnerNamesAtStart = new Set(getRunners().keys());

      // Collect all runner names referenced by this workflow
      const runnerNames = collectRunnerNames(workflow.tasks);

      // Register mock runner for each referenced runner
      for (const name of runnerNames) {
        registerRunner(name, mockRunner);
      }

      // Build merged hooks that update currentTask before delegating to workflow hooks
      const workflowHooks = workflow.hooks as WorkflowHooks | undefined;

      // Build hooks object carefully — exactOptionalPropertyTypes means we cannot
      // assign `undefined` to an optional property; we must omit the key instead.
      const harnessHooks: WorkflowHooks = {
        onTaskStart: (taskName: string) => {
          currentTask.value = taskName;
          workflowHooks?.onTaskStart?.(taskName as never);
        },
        ...(workflowHooks?.onTaskComplete !== undefined
          ? {
              onTaskComplete: (taskName: string, output: unknown, metrics: import("@agentflow/core").TaskMetrics) => {
                workflowHooks.onTaskComplete?.(taskName as never, output, metrics);
              },
            }
          : {}),
        ...(workflowHooks?.onTaskError !== undefined
          ? {
              onTaskError: (taskName: string, error: Error, latencyMs: number) => {
                workflowHooks.onTaskError?.(taskName as never, error, latencyMs);
              },
            }
          : {}),
        ...(workflowHooks?.onWorkflowComplete !== undefined
          ? { onWorkflowComplete: workflowHooks.onWorkflowComplete }
          : {}),
        ...(workflowHooks?.onCheckpoint !== undefined
          ? { onCheckpoint: workflowHooks.onCheckpoint }
          : {}),
      };

      const wrappedWorkflow: WorkflowDef = { ...workflow, hooks: harnessHooks };

      try {
        const executor = new WorkflowExecutor(wrappedWorkflow);
        return await executor.run(input);
      } finally {
        // Restore registry:
        // 1. Remove runners that were added by the harness (not present before patching)
        for (const name of runnerNames) {
          if (!runnerNamesAtStart.has(name)) {
            unregisterRunner(name);
          }
        }
        // 2. Re-register all previously saved runners (overwrites mock for names that existed)
        for (const [name, runner] of savedEntries) {
          registerRunner(name, runner);
        }
      }
    },

    getTask(name: string): TaskStats {
      const s = stats.get(name);
      if (s === undefined) {
        return { callCount: 0, retryCount: 0, outputs: [] };
      }
      return {
        callCount: s.callCount,
        retryCount: s.callCount - s.successCount,
        outputs: s.outputs,
      };
    },
  };
}
