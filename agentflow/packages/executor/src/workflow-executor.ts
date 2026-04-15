import { getRunner } from "@agentflow/core";
import type { AgentDef, TaskDef, TaskMetrics, TasksMap, WorkflowDef, WorkflowMetrics } from "@agentflow/core";
import { RunnerNotRegisteredError } from "./errors.js";
import { topologicalSort } from "./dag-resolver.js";
import { runNode } from "./node-runner.js";

export interface WorkflowResult<T extends TasksMap> {
  outputs: { [K in keyof T]?: unknown };
  metrics: WorkflowMetrics;
}

// Context entry stored for each completed task
interface CtxEntry {
  output: unknown;
  _source: "agent";
}

export class WorkflowExecutor<T extends TasksMap> {
  constructor(private readonly workflow: WorkflowDef<T>) {}

  async run(_input?: unknown): Promise<WorkflowResult<T>> {
    const { tasks, hooks } = this.workflow;
    const workflowStart = Date.now();

    // Topological sort to get execution batches
    const batches = topologicalSort(tasks);

    // Execution context: maps task name → output
    const ctx: Record<string, CtxEntry> = {};
    const outputs: { [K in keyof T]?: unknown } = {};

    // Accumulated metrics
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let taskCount = 0;

    // Phase 2: run sequentially even if a batch has multiple tasks
    for (const batch of batches) {
      for (const taskName of batch) {
        const taskDef = tasks[taskName];

        // Skip LoopDef tasks in Phase 2 (not implemented)
        if (taskDef === undefined || "kind" in taskDef) {
          continue;
        }

        // We know this is a TaskDef<AgentDef<...>, ...> here
        // biome-ignore lint/suspicious/noExplicitAny: structural constraint
        const task = taskDef as TaskDef<AgentDef<any, any, any>>;
        const runnerName: string = task.agent.runner;

        // Get runner from registry
        const runner = getRunner(runnerName);
        if (runner === undefined) {
          throw new RunnerNotRegisteredError(runnerName);
        }

        // Resolve input
        let resolvedInput: unknown;
        if (typeof task.input === "function") {
          resolvedInput = (task.input as (ctx: Record<string, CtxEntry>) => unknown)(ctx);
        } else {
          resolvedInput = task.input;
        }

        // Fire onTaskStart hook
        hooks?.onTaskStart?.(taskName as keyof T & string);

        try {
          const result = await runNode(task, resolvedInput, runner, taskName);

          // Store output in context
          const ctxEntry: CtxEntry = { output: result.output, _source: "agent" };
          ctx[taskName] = ctxEntry;
          outputs[taskName as keyof T] = result.output;

          taskCount++;
          totalTokensIn += result.tokensIn;
          totalTokensOut += result.tokensOut;

          const taskMetrics: TaskMetrics = {
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            latencyMs: result.latencyMs,
            retries: result.retries,
            estimatedCost: 0, // Phase 2: no cost calculation
          };

          // Fire onTaskComplete hook
          hooks?.onTaskComplete?.(taskName as keyof T & string, result.output, taskMetrics);
        } catch (err) {
          // Fire onTaskError hook
          if (err instanceof Error) {
            hooks?.onTaskError?.(taskName as keyof T & string, err, 0);
          }
          throw err;
        }
      }
    }

    const totalLatencyMs = Date.now() - workflowStart;

    const metrics: WorkflowMetrics = {
      totalLatencyMs,
      totalTokensIn,
      totalTokensOut,
      totalEstimatedCost: 0,
      taskCount,
    };

    // Fire onWorkflowComplete hook
    hooks?.onWorkflowComplete?.(outputs, metrics);

    return { outputs, metrics };
  }
}
