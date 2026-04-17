import { NodeMaxRetriesError, getRunner, resolveAgentDef } from "@ageflow/core";
import type {
  AgentDef,
  AttemptRecord,
  CheckpointEvent,
  FunctionDef,
  FunctionTaskDef,
  RetryConfig,
  RunnerOverrides,
  TaskDef,
  TaskMetrics,
  TasksMap,
  WorkflowDef,
  WorkflowEvent,
  WorkflowMetrics,
} from "@ageflow/core";
import { BudgetTracker } from "./budget-tracker.js";
import { topologicalSort } from "./dag-resolver.js";
import {
  HitlRejectedError,
  RunnerNotRegisteredError,
  WorkflowAbortedError,
} from "./errors.js";
import { HITLManager } from "./hitl-manager.js";
import { LoopExecutor } from "./loop-executor.js";
import { runNode } from "./node-runner.js";
import { classifyFnError } from "./retry-classify.js";
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

export interface StreamOptions {
  readonly signal?: AbortSignal;
  /**
   * Called when a checkpoint event is emitted. Returning `true` approves,
   * `false` rejects. If omitted, the checkpoint defers to HITLManager.
   */
  readonly onCheckpoint?: (ev: CheckpointEvent) => Promise<boolean> | boolean;
  /**
   * Per-runner overrides applied to every agent task in this run.
   *
   * Keyed by runner brand (e.g. `"api"`, `"anthropic"`). Runners merge
   * these on top of instance-level and agent-level settings.
   *
   * @example
   * await executor.run(input, {
   *   runnerOverrides: {
   *     api: { tools: makeToolsScopedTo(sellerAccountId) },
   *   },
   * });
   */
  readonly runnerOverrides?: RunnerOverrides;
}

// ─── Internal event queue ──────────────────────────────────────────────────────

function createEventQueue() {
  const pending: WorkflowEvent[] = [];
  let waiter: ((v: WorkflowEvent | null) => void) | null = null;
  let closed = false;
  return {
    push(ev: WorkflowEvent): void {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(ev);
      } else {
        pending.push(ev);
      }
    },
    close(): void {
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
      }
    },
    next(): Promise<WorkflowEvent | null> {
      if (pending.length > 0) return Promise.resolve(pending.shift() ?? null);
      if (closed) return Promise.resolve(null);
      return new Promise<WorkflowEvent | null>((resolve) => {
        waiter = resolve;
      });
    },
  };
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

// ─── Default retry config for function tasks ───────────────────────────────────

const DEFAULT_FN_RETRY: RetryConfig = {
  max: 1,
  on: [],
  backoff: "fixed",
};

// ─── Function task runner (with retry) ────────────────────────────────────────

/**
 * Run a function task with retry logic.
 * Validates input via inputSchema, calls execute(), validates output via outputSchema.
 *
 * Retry behavior:
 * - Input/output Zod validation errors are never retried (classified as "validation").
 *   They indicate a data contract violation; retrying won't fix it.
 * - Errors thrown from execute() are classified (see classifyFnError) and checked
 *   against retry.on before retrying — same semantics as agent tasks.
 *   If retry.on is empty ([]) no errors are retried regardless of retry.max.
 * - On exhaustion (or a non-retryable error kind), throws NodeMaxRetriesError with
 *   the full attempts array so the executor can report the correct attempt count
 *   in hooks and events.
 */
async function runFunctionTask<
  // biome-ignore lint/suspicious/noExplicitAny: structural constraint
  F extends FunctionDef<any, any>,
>(
  fnDef: F,
  // biome-ignore lint/suspicious/noExplicitAny: structural constraint
  resolvedInput: any,
  retry: RetryConfig,
  taskName: string,
  onRetry?: (attempt: number, reason: string) => void,
  // biome-ignore lint/suspicious/noExplicitAny: structural constraint
): Promise<{ output: any; latencyMs: number; retries: number }> {
  const maxAttempts = retry.max;
  const startTime = Date.now();

  // Validate input through Zod security boundary — never retried
  const parsedInput = fnDef.inputSchema.safeParse(resolvedInput);
  if (!parsedInput.success) {
    throw new Error(
      `[agentflow] Function task "${taskName}" input validation failed: ${parsedInput.error.message}`,
    );
  }

  const attemptRecords: AttemptRecord[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const rawOutput = await fnDef.execute(parsedInput.data);

      // Validate output through Zod security boundary — never retried
      const parsedOutput = fnDef.outputSchema.safeParse(rawOutput);
      if (!parsedOutput.success) {
        throw new Error(
          `[agentflow] Function task "${taskName}" output validation failed: ${parsedOutput.error.message}`,
        );
      }

      const latencyMs = Date.now() - startTime;
      return { output: parsedOutput.data, latencyMs, retries: attempt };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));

      // Zod validation errors (input/output) are never retried — data is wrong
      const isValidationError =
        e.message.includes("input validation failed") ||
        e.message.includes("output validation failed");
      if (isValidationError) {
        throw e;
      }

      // Classify the error and check retry.on — same semantics as agent tasks
      const errorCode = classifyFnError(e);
      if (!retry.on.includes(errorCode)) {
        // Error kind not in retry list — throw immediately without consuming attempts
        // Wrap as NodeMaxRetriesError so onTaskError gets attempt count = 1
        attemptRecords.push({ attempt, error: e.message, errorCode });
        throw new NodeMaxRetriesError(taskName, attemptRecords);
      }

      // Error is retryable — record this attempt
      attemptRecords.push({ attempt, error: e.message, errorCode });

      if (attempt < maxAttempts - 1) {
        onRetry?.(attempt + 1, e.message);
        // No backoff for function tasks — they're in-process calls
      }
    }
  }

  // All attempts exhausted — throw NodeMaxRetriesError so the executor can
  // report the correct attempt count in hooks (onTaskError) and events (task:error).
  throw new NodeMaxRetriesError(taskName, attemptRecords);
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

  async run(
    input?: unknown,
    options?: Omit<StreamOptions, "onCheckpoint">,
  ): Promise<WorkflowResult<T>> {
    const legacyHitlAdapter = async (ev: CheckpointEvent): Promise<boolean> => {
      // Legacy HITL adapter: defer to HITLManager (hook-or-TTY path).
      await this.hitlManager.runCheckpoint(
        ev.taskName,
        ev.message,
        this.workflow.hooks,
      );
      return true;
    };
    const gen = this.stream(input, {
      onCheckpoint: legacyHitlAdapter,
      ...(options ?? {}),
    });
    let result: IteratorResult<WorkflowEvent, WorkflowResult<T>>;
    do {
      result = await gen.next();
    } while (!result.done);
    return result.value;
  }

  /**
   * Stream workflow execution as an async generator of WorkflowEvents.
   * Returns the WorkflowResult as the generator's return value.
   * Hooks continue to fire alongside events. Existing run() is unchanged.
   */
  async *stream(
    input?: unknown,
    options?: StreamOptions,
  ): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void> {
    const runId = crypto.randomUUID();
    const workflowName = this.workflow.name;
    const queue = createEventQueue();

    // Emit workflow:start immediately.
    queue.push({
      type: "workflow:start",
      runId,
      workflowName,
      timestamp: Date.now(),
      input,
    });

    // Run the DAG in the background; push events via queue; close on exit.
    // We use a shared error slot instead of a rejected Promise to avoid
    // unhandled-rejection warnings when the generator is suspended
    // (e.g. async HITL timeout): the error is already communicated via the
    // queue as workflow:error and will be re-thrown from `return driverResult`
    // once the consumer drains the queue.
    let driverResult: WorkflowResult<T> | undefined;
    let driverError: Error | undefined;
    const driverDone = (async (): Promise<void> => {
      try {
        const result = await this._runBatchesEmitting(
          this.workflow.tasks,
          {},
          undefined,
          {
            runId,
            workflowName,
            push: (ev) => queue.push(ev),
            ...(options?.onCheckpoint !== undefined
              ? { onCheckpoint: options.onCheckpoint }
              : {}),
            ...(options?.signal !== undefined
              ? { signal: options.signal }
              : {}),
            ...(options?.runnerOverrides !== undefined
              ? { runnerOverrides: options.runnerOverrides }
              : {}),
          },
        );
        // Fire onWorkflowComplete hook (was fired at end of old run())
        await this.workflow.hooks?.onWorkflowComplete?.(
          result.outputs,
          result.metrics,
        );
        queue.push({
          type: "workflow:complete",
          runId,
          workflowName,
          timestamp: Date.now(),
          result: {
            outputs: result.outputs as Record<string, unknown>,
            metrics: result.metrics,
          },
        });
        driverResult = result;
        queue.close();
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        queue.push({
          type: "workflow:error",
          runId,
          workflowName,
          timestamp: Date.now(),
          error: {
            name: e.name,
            message: e.message,
            ...(e.stack !== undefined ? { stack: e.stack } : {}),
          },
        });
        driverError = e;
        queue.close();
      }
    })();
    // Suppress the floating promise rejection (the IIFE returns void / never rejects).
    void driverDone;

    while (true) {
      const ev = await queue.next();
      if (ev === null) break;
      yield ev;
    }

    // Await the driver to ensure it has fully completed before returning.
    await driverDone;
    if (driverError !== undefined) throw driverError;
    return driverResult as WorkflowResult<T>;
  }

  /**
   * Run batches of tasks, returning the accumulated context entries.
   * Used by both the top-level run() and LoopExecutor.
   *
   * @param sessionManagerOverride - When provided (by LoopExecutor), use this
   *   session manager for inner-loop tasks instead of the top-level one (C1 fix).
   * @param runnerOverrides - Per-runner overrides from execute()/stream() options.
   */
  private async _runBatches(
    tasks: TasksMap,
    initialCtx: Record<string, CtxEntry>,
    sessionManagerOverride?: SessionManager,
    runnerOverrides?: RunnerOverrides,
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

            // Dispatch FunctionTaskDef ({fn: ...}) — non-LLM deterministic step
            if ("fn" in taskDef) {
              // biome-ignore lint/suspicious/noExplicitAny: structural constraint
              const fnTask = taskDef as FunctionTaskDef<FunctionDef<any, any>>;

              // Evaluate skipIf predicate
              if (fnTask.skipIf !== undefined) {
                let shouldSkip: boolean;
                try {
                  shouldSkip = (
                    fnTask.skipIf as (ctx: Record<string, CtxEntry>) => boolean
                  )(ctx);
                } catch (err) {
                  const e = err instanceof Error ? err : new Error(String(err));
                  hooks?.onTaskError?.(taskName as keyof T & string, e, 0);
                  throw e;
                }
                if (shouldSkip) {
                  ctx[taskName] = { output: undefined, _source: "skipped" };
                  hooks?.onTaskSkip?.(taskName as keyof T & string, "skipIf");
                  continue;
                }
              }

              // Resolve input
              let fnResolvedInput: unknown;
              if (typeof fnTask.input === "function") {
                fnResolvedInput = (
                  fnTask.input as (ctx: Record<string, CtxEntry>) => unknown
                )(ctx);
              } else {
                fnResolvedInput = fnTask.input;
              }

              const fnRetry: RetryConfig = {
                max: fnTask.retry?.max ?? DEFAULT_FN_RETRY.max,
                on: fnTask.retry?.on ?? DEFAULT_FN_RETRY.on,
                backoff: fnTask.retry?.backoff ?? DEFAULT_FN_RETRY.backoff,
              };

              // Fire onTaskStart hook
              hooks?.onTaskStart?.(taskName as keyof T & string);

              try {
                const fnResult = await runFunctionTask(
                  fnTask.fn,
                  fnResolvedInput,
                  fnRetry,
                  taskName,
                );

                ctx[taskName] = {
                  output: fnResult.output,
                  _source: "function",
                };

                const fnMetrics: TaskMetrics = {
                  tokensIn: 0,
                  tokensOut: 0,
                  latencyMs: fnResult.latencyMs,
                  retries: fnResult.retries,
                  estimatedCost: 0,
                };

                hooks?.onTaskComplete?.(
                  taskName as keyof T & string,
                  fnResult.output,
                  fnMetrics,
                );
              } catch (err) {
                if (err instanceof Error) {
                  const attemptCount =
                    err instanceof NodeMaxRetriesError
                      ? err.attempts.length
                      : 1;
                  hooks?.onTaskError?.(
                    taskName as keyof T & string,
                    err,
                    attemptCount,
                  );
                }
                throw err;
              }
              continue;
            }

            // This is a TaskDef<AgentDef<...>>
            // biome-ignore lint/suspicious/noExplicitAny: structural constraint
            const task = taskDef as TaskDef<AgentDef<any, any, any>>;

            // Evaluate skipIf predicate before any runner/HITL/budget work
            if (task.skipIf !== undefined) {
              let shouldSkip: boolean;
              try {
                shouldSkip = (
                  task.skipIf as (ctx: Record<string, CtxEntry>) => boolean
                )(ctx);
              } catch (err) {
                const e = err instanceof Error ? err : new Error(String(err));
                hooks?.onTaskError?.(taskName as keyof T & string, e, 0);
                throw e;
              }
              if (shouldSkip) {
                ctx[taskName] = { output: undefined, _source: "skipped" };
                hooks?.onTaskSkip?.(taskName as keyof T & string, "skipIf");
                continue;
              }
            }

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
            const {
              tools: filteredTools,
              permissions,
              enforcing: hitlEnforcing,
            } = this.hitlManager.applyPermissions(
              resolvedDef.tools,
              hitlConfig,
            );

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
              const nodeOpts: import("./node-runner.js").RunNodeOpts = {
                ...(hooks !== undefined ? { hooks } : {}),
                ...(permissions !== undefined ? { permissions } : {}),
                ...(filteredTools !== undefined ? { filteredTools } : {}),
                hitlEnforcing,
                ...(this.workflow.mcpServers !== undefined
                  ? { workflowMcpServers: this.workflow.mcpServers }
                  : {}),
                ...(runnerOverrides !== undefined ? { runnerOverrides } : {}),
              };
              const result = await runNode(
                task,
                resolvedInput,
                runner,
                taskName,
                sessionHandle,
                nodeOpts,
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
                // Fire onExceeded callback BEFORE halt/warn — ensures it runs even if halt throws
                await this.budgetTracker.fireOnExceeded(
                  budget,
                  taskName,
                  this.workflow.name,
                );
                // THEN halt or warn
                if (budget.onExceed === "halt") {
                  this.budgetTracker.checkBudget(budget);
                } else if (budget.onExceed === "warn") {
                  console.warn(
                    "[AgentFlow] Budget warning: spent $%s (limit $%s)",
                    this.budgetTracker.total.toFixed(4),
                    budget.maxCost.toFixed(4),
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
                promptSent: result.promptSent,
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
                const attemptCount =
                  err instanceof NodeMaxRetriesError ? err.attempts.length : 1;
                hooks?.onTaskError?.(
                  taskName as keyof T & string,
                  err,
                  attemptCount,
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

  /**
   * Core DAG walk for stream() — emits WorkflowEvents via push().
   * This is the new stream path; _runBatches() remains unchanged for run().
   */
  private async _runBatchesEmitting(
    tasks: TasksMap,
    initialCtx: Record<string, CtxEntry>,
    sessionManagerOverride: SessionManager | undefined,
    emitting: {
      runId: string;
      workflowName: string;
      push: (ev: WorkflowEvent) => void;
      onCheckpoint?: (ev: CheckpointEvent) => Promise<boolean> | boolean;
      signal?: AbortSignal;
      runnerOverrides?: RunnerOverrides;
    },
  ): Promise<WorkflowResult<T>> {
    const { runId, workflowName, push, onCheckpoint, signal, runnerOverrides } =
      emitting;
    const { hooks, budget } = this.workflow;
    const sm = sessionManagerOverride ?? this.sessionManager;
    const workflowStart = Date.now();

    // Topological sort to get execution batches
    const batches = topologicalSort(tasks);

    // Working context — accumulates outputs as tasks complete
    const ctx: Record<string, CtxEntry> = { ...initialCtx };

    // Metrics accumulators
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let taskCount = 0;

    for (const batch of batches) {
      // Check AbortSignal at every batch boundary (P1-2)
      if (signal?.aborted) {
        throw new WorkflowAbortedError();
      }

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
            // Check AbortSignal before each task within a group (P1-2)
            if (signal?.aborted) {
              throw new WorkflowAbortedError();
            }

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

            // Dispatch FunctionTaskDef ({fn: ...}) — non-LLM deterministic step
            if ("fn" in taskDef) {
              // biome-ignore lint/suspicious/noExplicitAny: structural constraint
              const fnTask = taskDef as FunctionTaskDef<FunctionDef<any, any>>;

              // Evaluate skipIf predicate
              if (fnTask.skipIf !== undefined) {
                let shouldSkip: boolean;
                try {
                  shouldSkip = (
                    fnTask.skipIf as (ctx: Record<string, CtxEntry>) => boolean
                  )(ctx);
                } catch (err) {
                  const e = err instanceof Error ? err : new Error(String(err));
                  hooks?.onTaskError?.(taskName as keyof T & string, e, 0);
                  push({
                    type: "task:error",
                    runId,
                    workflowName,
                    timestamp: Date.now(),
                    taskName,
                    error: {
                      name: e.name,
                      message: e.message,
                      ...(e.stack !== undefined ? { stack: e.stack } : {}),
                    },
                    attempt: 0,
                    terminal: true,
                  });
                  throw e;
                }
                if (shouldSkip) {
                  ctx[taskName] = { output: undefined, _source: "skipped" };
                  hooks?.onTaskSkip?.(taskName as keyof T & string, "skipIf");
                  push({
                    type: "task:skip",
                    runId,
                    workflowName,
                    timestamp: Date.now(),
                    taskName,
                    reason: "skipIf",
                  });
                  continue;
                }
              }

              // Resolve input
              let fnResolvedInput: unknown;
              if (typeof fnTask.input === "function") {
                fnResolvedInput = (
                  fnTask.input as (ctx: Record<string, CtxEntry>) => unknown
                )(ctx);
              } else {
                fnResolvedInput = fnTask.input;
              }

              const fnRetry: RetryConfig = {
                max: fnTask.retry?.max ?? DEFAULT_FN_RETRY.max,
                on: fnTask.retry?.on ?? DEFAULT_FN_RETRY.on,
                backoff: fnTask.retry?.backoff ?? DEFAULT_FN_RETRY.backoff,
              };

              // Fire onTaskStart hook + emit task:start event
              hooks?.onTaskStart?.(taskName as keyof T & string);
              push({
                type: "task:start",
                runId,
                workflowName,
                timestamp: Date.now(),
                taskName,
              });

              try {
                const fnResult = await runFunctionTask(
                  fnTask.fn,
                  fnResolvedInput,
                  fnRetry,
                  taskName,
                  (attempt, reason) => {
                    push({
                      type: "task:retry",
                      runId,
                      workflowName,
                      timestamp: Date.now(),
                      taskName,
                      attempt,
                      reason,
                    });
                  },
                );

                ctx[taskName] = {
                  output: fnResult.output,
                  _source: "function",
                };
                taskCount++;

                const fnMetrics: TaskMetrics = {
                  tokensIn: 0,
                  tokensOut: 0,
                  latencyMs: fnResult.latencyMs,
                  retries: fnResult.retries,
                  estimatedCost: 0,
                };

                hooks?.onTaskComplete?.(
                  taskName as keyof T & string,
                  fnResult.output,
                  fnMetrics,
                );
                push({
                  type: "task:complete",
                  runId,
                  workflowName,
                  timestamp: Date.now(),
                  taskName,
                  output: fnResult.output,
                  metrics: fnMetrics,
                });
              } catch (err) {
                const e = err instanceof Error ? err : new Error(String(err));
                const attemptCount =
                  err instanceof NodeMaxRetriesError ? err.attempts.length : 1;
                hooks?.onTaskError?.(
                  taskName as keyof T & string,
                  e,
                  attemptCount,
                );
                push({
                  type: "task:error",
                  runId,
                  workflowName,
                  timestamp: Date.now(),
                  taskName,
                  error: {
                    name: e.name,
                    message: e.message,
                    ...(e.stack !== undefined ? { stack: e.stack } : {}),
                  },
                  attempt: attemptCount,
                  terminal: true,
                });
                throw e;
              }
              continue;
            }

            // This is a TaskDef<AgentDef<...>>
            // biome-ignore lint/suspicious/noExplicitAny: structural constraint
            const task = taskDef as TaskDef<AgentDef<any, any, any>>;

            // Evaluate skipIf predicate before any runner/HITL/budget work
            if (task.skipIf !== undefined) {
              let shouldSkip: boolean;
              try {
                shouldSkip = (
                  task.skipIf as (ctx: Record<string, CtxEntry>) => boolean
                )(ctx);
              } catch (err) {
                const e = err instanceof Error ? err : new Error(String(err));
                hooks?.onTaskError?.(taskName as keyof T & string, e, 0);
                push({
                  type: "task:error",
                  runId,
                  workflowName,
                  timestamp: Date.now(),
                  taskName,
                  error: {
                    name: e.name,
                    message: e.message,
                    ...(e.stack !== undefined ? { stack: e.stack } : {}),
                  },
                  attempt: 0,
                  terminal: true,
                });
                throw e;
              }
              if (shouldSkip) {
                ctx[taskName] = { output: undefined, _source: "skipped" };
                hooks?.onTaskSkip?.(taskName as keyof T & string, "skipIf");
                // Emit task:skip event
                push({
                  type: "task:skip",
                  runId,
                  workflowName,
                  timestamp: Date.now(),
                  taskName,
                  reason: "skipIf",
                });
                continue;
              }
            }

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
            const {
              tools: filteredTools,
              permissions,
              enforcing: hitlEnforcing,
            } = this.hitlManager.applyPermissions(
              resolvedDef.tools,
              hitlConfig,
            );

            // Run HITL checkpoint if mode is "checkpoint"
            if (hitlConfig.mode === "checkpoint") {
              const checkpointMessage =
                "message" in hitlConfig && hitlConfig.message !== undefined
                  ? hitlConfig.message
                  : `Task "${taskName}" requires approval before proceeding.`;

              // Emit checkpoint event
              const checkpointEv: CheckpointEvent = {
                type: "checkpoint",
                runId,
                workflowName,
                timestamp: Date.now(),
                taskName,
                message: checkpointMessage,
              };
              push(checkpointEv);

              if (onCheckpoint !== undefined) {
                // Caller-provided handler (stream() path).
                // Single-ownership: when caller supplies onCheckpoint, it is
                // solely responsible for approval. hooks.onCheckpoint is NOT
                // fired here — the caller's handler owns the side-effect.
                const approved = await onCheckpoint(checkpointEv);
                if (!approved) {
                  throw new HitlRejectedError(taskName);
                }
              } else {
                // Legacy path: defer to HITLManager (TTY / hook).
                // HITLManager fires hooks.onCheckpoint internally — no
                // double-call.
                await this.hitlManager.runCheckpoint(
                  taskName,
                  checkpointMessage,
                  hooks,
                );
              }
            }

            // Get existing session handle for this task (use sm: may be loop-local)
            const sessionHandle = sm.getHandle(taskName);

            // Fire onTaskStart hook
            hooks?.onTaskStart?.(taskName as keyof T & string);

            // Emit task:start event
            push({
              type: "task:start",
              runId,
              workflowName,
              timestamp: Date.now(),
              taskName,
            });

            const taskStart = Date.now();
            try {
              const nodeOpts: import("./node-runner.js").RunNodeOpts = {
                ...(hooks !== undefined ? { hooks } : {}),
                ...(permissions !== undefined ? { permissions } : {}),
                ...(filteredTools !== undefined ? { filteredTools } : {}),
                hitlEnforcing,
                onRetry: (attempt, reason) => {
                  push({
                    type: "task:retry",
                    runId,
                    workflowName,
                    timestamp: Date.now(),
                    taskName,
                    attempt,
                    reason,
                  });
                },
                ...(this.workflow.mcpServers !== undefined
                  ? { workflowMcpServers: this.workflow.mcpServers }
                  : {}),
                ...(runnerOverrides !== undefined ? { runnerOverrides } : {}),
              };
              const result = await runNode(
                task,
                resolvedInput,
                runner,
                taskName,
                sessionHandle,
                nodeOpts,
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

              // Check budget per-task after adding cost
              if (budget !== undefined && this.budgetTracker.exceeded(budget)) {
                // Fire onExceeded callback BEFORE halt/warn — ensures it runs even if halt throws
                await this.budgetTracker.fireOnExceeded(
                  budget,
                  taskName,
                  workflowName,
                );
                // THEN halt or warn
                if (budget.onExceed === "halt") {
                  this.budgetTracker.checkBudget(budget);
                } else if (budget.onExceed === "warn") {
                  push({
                    type: "budget:warning",
                    runId,
                    workflowName,
                    timestamp: Date.now(),
                    spentUsd: this.budgetTracker.total,
                    limitUsd: budget.maxCost,
                  });
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
              totalTokensIn += result.tokensIn;
              totalTokensOut += result.tokensOut;
              taskCount++;

              const taskMetrics: TaskMetrics = {
                tokensIn: result.tokensIn,
                tokensOut: result.tokensOut,
                latencyMs,
                retries: result.retries,
                estimatedCost,
                promptSent: result.promptSent,
              };

              // Fire onTaskComplete hook
              hooks?.onTaskComplete?.(
                taskName as keyof T & string,
                result.output,
                taskMetrics,
              );

              // Emit task:complete event
              push({
                type: "task:complete",
                runId,
                workflowName,
                timestamp: Date.now(),
                taskName,
                output: result.output,
                metrics: taskMetrics,
              });
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err));
              // Derive actual attempt count from NodeMaxRetriesError when available
              const attemptCount =
                err instanceof NodeMaxRetriesError ? err.attempts.length : 1;
              // Fire onTaskError hook
              hooks?.onTaskError?.(
                taskName as keyof T & string,
                e,
                attemptCount,
              );

              // Emit task:error event (terminal: true — retries exhausted or non-retryable)
              push({
                type: "task:error",
                runId,
                workflowName,
                timestamp: Date.now(),
                taskName,
                error: {
                  name: e.name,
                  message: e.message,
                  ...(e.stack !== undefined ? { stack: e.stack } : {}),
                },
                attempt: attemptCount,
                terminal: true,
              });

              throw err;
            }
          }
        }),
      );
    }

    // Build outputs from ctx (only tasks defined in the tasks map)
    const outputs: { [K in keyof T]?: unknown } = {};
    for (const taskName of Object.keys(tasks)) {
      if (ctx[taskName] !== undefined) {
        outputs[taskName as keyof T] = ctx[taskName]?.output;
      }
    }

    const totalLatencyMs = Date.now() - workflowStart;
    const totalEstimatedCost = this.budgetTracker.total;

    const metrics: WorkflowMetrics = {
      totalLatencyMs,
      totalTokensIn,
      totalTokensOut,
      totalEstimatedCost,
      taskCount,
    };

    return { outputs, metrics };
  }
}
