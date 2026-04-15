import { getRunner, resolveAgentDef } from "@ageflow/core";
import type {
  AgentDef,
  TaskDef,
  TaskMetrics,
  TasksMap,
  WorkflowDef,
  WorkflowMetrics,
} from "@ageflow/core";
import { BudgetTracker } from "./budget-tracker.js";
import { topologicalSort } from "./dag-resolver.js";
import { RunnerNotRegisteredError } from "./errors.js";
import { HITLManager } from "./hitl-manager.js";
import { LoopExecutor } from "./loop-executor.js";
import { runNode } from "./node-runner.js";
import { SessionManager } from "./session-manager.js";
import type { CtxEntry, RunBatchesFn } from "./types-internal.js";

export type { RunBatchesFn } from "./types-internal.js";

export interface WorkflowResult<T extends TasksMap> {
  outputs: { [K in keyof T]?: unknown };
  metrics: WorkflowMetrics;
}

interface WorkflowExecutorOptions {
  sessionManager?: SessionManager;
  hitlManager?: HITLManager;
  budgetTracker?: BudgetTracker;
}

/**
 * Group batch tasks by canonical session token.
 * Tasks that share a session must run sequentially within a group.
 * Tasks with different (or no) sessions run in parallel across groups.
 *
 * Returns: array of groups, each group is an array of task names that must run sequentially.
 */
function groupBySession(
  batch: readonly string[],
  sessionManager: SessionManager,
): string[][] {
  const groups: string[][] = [];
  // token name → group index
  const tokenToGroup = new Map<string, number>();

  for (const taskName of batch) {
    const token = sessionManager.canonicalToken(taskName);

    if (token === undefined) {
      // No session — own group (runs in parallel)
      groups.push([taskName]);
    } else {
      const existingIndex = tokenToGroup.get(token);
      if (existingIndex !== undefined) {
        // Append to existing group for this token
        groups[existingIndex]?.push(taskName);
      } else {
        // New group for this token
        const newIndex = groups.length;
        tokenToGroup.set(token, newIndex);
        groups.push([taskName]);
      }
    }
  }

  return groups;
}

export class WorkflowExecutor<T extends TasksMap> {
  private readonly sessionManager: SessionManager;
  private readonly hitlManager: HITLManager;
  private readonly budgetTracker: BudgetTracker;
  private readonly loopExecutor: LoopExecutor;

  constructor(
    private readonly workflow: WorkflowDef<T>,
    options?: WorkflowExecutorOptions,
  ) {
    this.sessionManager =
      options?.sessionManager ?? new SessionManager(workflow.tasks);
    this.hitlManager = options?.hitlManager ?? new HITLManager();
    this.budgetTracker = options?.budgetTracker ?? new BudgetTracker();

    // Bind runBatches so LoopExecutor can call it without circular import
    const runBatchesBound: RunBatchesFn = (tasks, ctx, sm) =>
      this._runBatches(tasks, ctx, sm);
    this.loopExecutor = new LoopExecutor(runBatchesBound);
  }

  async run(_input?: unknown): Promise<WorkflowResult<T>> {
    const { tasks, hooks } = this.workflow;
    const workflowStart = Date.now();

    // Build initial context
    const ctx: Record<string, CtxEntry> = {};
    const outputs: { [K in keyof T]?: unknown } = {};

    // Accumulated metrics
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalEstimatedCost = 0;
    let taskCount = 0;

    // Run all task batches
    const results = await this._runBatches(tasks, ctx);

    // Merge results into outputs
    for (const [taskName, entry] of Object.entries(results)) {
      outputs[taskName as keyof T] = entry.output;
      if (entry._source === "agent") {
        taskCount++;
      }
    }

    // Accumulate totals from budget tracker
    totalEstimatedCost = this.budgetTracker.total;

    // We need to collect token counts from individual task results
    // The _runBatches aggregates back into ctx — we compute totals from budgetTracker
    // For token counts, we need to re-examine ctx
    for (const entry of Object.values(results)) {
      if (entry._source === "agent") {
        const tokenEntry = entry as CtxEntry & {
          _tokensIn?: number;
          _tokensOut?: number;
        };
        totalTokensIn += tokenEntry._tokensIn ?? 0;
        totalTokensOut += tokenEntry._tokensOut ?? 0;
      }
    }

    const totalLatencyMs = Date.now() - workflowStart;

    const metrics: WorkflowMetrics = {
      totalLatencyMs,
      totalTokensIn,
      totalTokensOut,
      totalEstimatedCost,
      taskCount,
    };

    // Fire onWorkflowComplete hook
    hooks?.onWorkflowComplete?.(outputs, metrics);

    return { outputs, metrics };
  }

  /**
   * Run batches of tasks, returning the accumulated context entries.
   * Used by both the top-level run() and LoopExecutor.
   *
   * @param sessionManagerOverride - When provided (by LoopExecutor), use this
   *   session manager for inner-loop tasks instead of the top-level one (C1 fix).
   */
  private async _runBatches(
    tasks: TasksMap,
    initialCtx: Record<string, CtxEntry>,
    sessionManagerOverride?: SessionManager,
  ): Promise<Record<string, CtxEntry>> {
    const { hooks, budget } = this.workflow;
    const sm = sessionManagerOverride ?? this.sessionManager;

    // Topological sort to get execution batches
    const batches = topologicalSort(tasks);

    // Working context — accumulates outputs as tasks complete
    const ctx: Record<string, CtxEntry> = { ...initialCtx };

    for (const batch of batches) {
      // Check budget before each batch
      if (budget !== undefined) {
        this.budgetTracker.checkBudget(budget);
      }

      // Group batch tasks by canonical session token (D1)
      const groups = groupBySession(batch, sm);

      // Each group runs sequentially; groups run in parallel
      await Promise.all(
        groups.map(async (group) => {
          for (const taskName of group) {
            const taskDef = tasks[taskName];
            if (taskDef === undefined) continue;

            // Dispatch LoopDef to LoopExecutor
            if ("kind" in taskDef) {
              const loopOutput = await this.loopExecutor.run(
                taskDef,
                ctx,
                taskName,
              );
              ctx[taskName] = { output: loopOutput, _source: "loop" };
              continue;
            }

            // This is a TaskDef<AgentDef<...>>
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
              resolvedInput = (
                task.input as (ctx: Record<string, CtxEntry>) => unknown
              )(ctx);
            } else {
              resolvedInput = task.input;
            }

            // Resolve HITL config (task-level overrides agent-level)
            const resolvedDef = resolveAgentDef(task.agent);
            const hitlConfig = this.hitlManager.resolveConfig(
              resolvedDef.hitl,
              task.hitl,
            );

            // Apply permissions if mode is "permissions"
            const { tools: filteredTools, permissions } =
              this.hitlManager.applyPermissions(resolvedDef.tools, hitlConfig);

            // Run HITL checkpoint if mode is "checkpoint"
            if (hitlConfig.mode === "checkpoint") {
              const checkpointMessage =
                "message" in hitlConfig && hitlConfig.message !== undefined
                  ? hitlConfig.message
                  : `Task "${taskName}" requires approval before proceeding.`;
              await this.hitlManager.runCheckpoint(
                taskName,
                checkpointMessage,
                hooks,
              );
            }

            // Get existing session handle for this task (use sm: may be loop-local)
            const sessionHandle = sm.getHandle(taskName);

            // Fire onTaskStart hook
            hooks?.onTaskStart?.(taskName as keyof T & string);

            const taskStart = Date.now();
            try {
              const result = await runNode(
                task,
                resolvedInput,
                runner,
                taskName,
                sessionHandle,
                permissions ?? undefined,
                filteredTools,
              );

              const latencyMs = Date.now() - taskStart;

              // Store session handle after task completes (use sm: may be loop-local)
              if (
                result.sessionHandle !== undefined &&
                result.sessionHandle !== ""
              ) {
                sm.setHandle(taskName, result.sessionHandle);
              }

              // Calculate estimated cost and accumulate
              const model = resolvedDef.model ?? "_default";
              const estimatedCost = this.budgetTracker.costFor(
                model,
                result.tokensIn,
                result.tokensOut,
              );
              this.budgetTracker.addCost(
                model,
                result.tokensIn,
                result.tokensOut,
              );

              // Check budget per-task after adding cost (I2 fix: catch overrun mid-batch)
              if (budget !== undefined && this.budgetTracker.exceeded(budget)) {
                if (budget.onExceed === "halt") {
                  this.budgetTracker.checkBudget(budget);
                } else if (budget.onExceed === "warn") {
                  console.warn(
                    `[AgentFlow] Budget warning: spent $${this.budgetTracker.total.toFixed(4)} (limit $${budget.maxCost.toFixed(4)})`,
                  );
                }
              }

              // Store output in context with token metadata for aggregation
              const ctxEntry: CtxEntry & {
                _tokensIn: number;
                _tokensOut: number;
              } = {
                output: result.output,
                _source: "agent",
                _tokensIn: result.tokensIn,
                _tokensOut: result.tokensOut,
              };
              ctx[taskName] = ctxEntry;

              const taskMetrics: TaskMetrics = {
                tokensIn: result.tokensIn,
                tokensOut: result.tokensOut,
                latencyMs,
                retries: result.retries,
                estimatedCost,
              };

              // Fire onTaskComplete hook
              hooks?.onTaskComplete?.(
                taskName as keyof T & string,
                result.output,
                taskMetrics,
              );
            } catch (err) {
              // Fire onTaskError hook
              if (err instanceof Error) {
                const latencyMs = Date.now() - taskStart;
                hooks?.onTaskError?.(
                  taskName as keyof T & string,
                  err,
                  latencyMs,
                );
              }
              throw err;
            }
          }
        }),
      );
    }

    return ctx;
  }
}
