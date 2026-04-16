import type {
  RunnerSpawnArgs,
  RunnerSpawnResult,
  WorkflowDef,
  WorkflowEvent,
} from "@ageflow/core";
import { registerRunner, unregisterRunner } from "@ageflow/core";
import { type Runner, createRunner } from "@ageflow/server";
import { ErrorCode, McpServerError, formatErrorResult } from "./errors.js";
import { JobEventRecorder } from "./job-event-recorder.js";
import type { McpToolResult } from "./server.js";
import type { ToolDefinition } from "./tool-registry.js";
import type { EffectiveCeilings } from "./types.js";

export interface JobDispatchContext {
  readonly runner: Runner;
  readonly recorder: JobEventRecorder;
  readonly workflow: WorkflowDef;
  readonly tool: ToolDefinition; // sync tool (for output validation)
  readonly jobTools: readonly ToolDefinition[]; // full job-tool array
  /** Executor injection hook from tests (mirrors sync path's _testRunExecutor). */
  testRunExecutor?: (input: unknown) => Promise<unknown>;
  /**
   * Test-only callback: called with the fully-composed workflow just before
   * runner.fire(). Allows tests to assert that ceilings and hooks were correctly
   * merged without needing to intercept the executor itself.
   */
  _testOnComposedWorkflow?: (workflow: WorkflowDef) => void;
  /** Task count in the workflow (for progress.tasksTotal). */
  readonly taskCount: number;
  /** Called from fire() onComplete/onError to release the inflight lock. */
  readonly releaseInflight: () => void;
}

export interface DispatchStartOptions {
  /** Effective ceilings (from composeCeilings) to apply to workflow budget. */
  readonly effective: EffectiveCeilings;
  /**
   * Checkpoint resolver for HITL strategy:
   * - "auto": () => true  (approve all)
   * - "fail": () => false  (reject all)
   * - "elicit": undefined  (deferred path — client calls resume_workflow)
   *
   * When undefined, runner.fire falls back to the deferred mechanism:
   * the run pauses at each checkpoint until resume_workflow resolves it.
   * This is the correct async-mode equivalent of "elicit" strategy.
   */
  readonly onCheckpoint?: (
    ev: import("@ageflow/core").CheckpointEvent,
  ) => boolean;
  /**
   * Abort signal for the DurationWatchdog (sync path uses Promise.race;
   * async path wires the signal directly into runner.fire so the internal
   * executor respects it). Undefined when no duration ceiling is set.
   */
  readonly abortSignal?: AbortSignal;
}

export async function dispatchStart(
  _toolName: string,
  args: unknown,
  ctx: JobDispatchContext,
  runOpts: DispatchStartOptions,
): Promise<McpToolResult> {
  // Validate input via the sync tool's input Zod (shared between sync + async)
  const inputTaskDef = ctx.workflow.tasks[ctx.tool.inputTask] as {
    agent: { input: import("zod").ZodType };
  };
  const parsed = inputTaskDef.agent.input.safeParse(args);
  if (!parsed.success) {
    // Release inflight lock on validation failure (caller already set it)
    ctx.releaseInflight();
    return formatErrorResult(
      new McpServerError(
        ErrorCode.INPUT_VALIDATION_FAILED,
        `schema validation failed: ${String(parsed.error)}`,
        { error: parsed.error },
      ),
    );
  }

  // Build the composed workflow — apply ceiling overrides and HITL hooks.
  // This mirrors the setup done on the sync path (composeCeilings + buildMcpHooks)
  // so that both paths behave identically with respect to CLI ceilings and HITL.
  const composedWorkflow = applyRunOpts(
    ctx.workflow,
    ctx.tool.inputTask,
    parsed.data,
    runOpts,
  );

  // Notify test observers with the composed workflow (test-only hook).
  ctx._testOnComposedWorkflow?.(composedWorkflow);

  // If a test executor is injected, temporarily register a fake runner that
  // delegates to it. This ensures runner.fire() still registers the handle in
  // the RunRegistry, so observer tools (get_workflow_status, cancel_workflow,
  // etc.) can find it via runner.get(runId).
  //
  // In test mode, dispatchStart awaits job completion so that tests can do
  //   `await h.callTool("start_ask", ...)` and then immediately call observer
  //   tools without races. (In production, start_* returns jobId immediately
  //   and the runner background loop is truly fire-and-forget.)
  if (ctx.testRunExecutor !== undefined) {
    const testExec = ctx.testRunExecutor;
    // Get the runner name used by the input task's agent
    const inputAgent = ctx.workflow.tasks[ctx.tool.inputTask] as {
      agent: { runner: string; output: import("zod").ZodType };
    };
    const runnerName = inputAgent.agent.runner;

    // Register a temporary runner for the duration of this fire() call
    const fakeRunner = {
      validate: async () => ({ ok: true }),
      spawn: async (
        _spawnArgs: RunnerSpawnArgs,
      ): Promise<RunnerSpawnResult> => {
        const output = await testExec(parsed.data);
        return {
          stdout: JSON.stringify(output),
          sessionHandle: "test",
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    };
    registerRunner(runnerName, fakeRunner);

    const handle = ctx.runner.fire(composedWorkflow, parsed.data, {
      ...(runOpts.abortSignal !== undefined
        ? { signal: runOpts.abortSignal }
        : {}),
      // Apply HITL strategy: "auto" → approve, "fail" → reject, "elicit" → deferred.
      ...(runOpts.onCheckpoint !== undefined
        ? {
            // biome-ignore lint/style/noNonNullAssertion: guarded by outer !== undefined check
            onCheckpoint: (ev) => runOpts.onCheckpoint!(ev),
          }
        : {}),
      onEvent: (ev: WorkflowEvent) => ctx.recorder.record(ev),
      onComplete: () => {
        unregisterRunner(runnerName);
        ctx.releaseInflight();
      },
      onError: () => {
        unregisterRunner(runnerName);
        ctx.releaseInflight();
      },
    });

    const jobId = handle.runId;
    // Return the result immediately so the caller has the jobId.
    // completionPromise is available for tests that need to sync on completion.
    return {
      content: [{ type: "text", text: JSON.stringify({ jobId }) }],
      structuredContent: { jobId },
      isError: false,
    };
  }

  const handle = ctx.runner.fire(composedWorkflow, parsed.data, {
    // Wire the DurationWatchdog abort signal (if any) so the internal executor
    // honours the duration ceiling on the async path.
    ...(runOpts.abortSignal !== undefined
      ? { signal: runOpts.abortSignal }
      : {}),
    // Apply HITL strategy from runOpts:
    //   - "auto" maps to onCheckpoint: () => true
    //   - "fail" maps to onCheckpoint: () => false
    //   - "elicit" maps to undefined → runner uses deferred path so
    //     resume_workflow can resolve checkpoints externally.
    ...(runOpts.onCheckpoint !== undefined
      ? {
          // biome-ignore lint/style/noNonNullAssertion: guarded by outer !== undefined check
          onCheckpoint: (ev) => runOpts.onCheckpoint!(ev),
        }
      : {}),
    onEvent: (ev: WorkflowEvent) => ctx.recorder.record(ev),
    onComplete: () => {
      ctx.releaseInflight();
    },
    onError: () => {
      ctx.releaseInflight();
    },
  });

  return {
    content: [{ type: "text", text: JSON.stringify({ jobId: handle.runId }) }],
    structuredContent: { jobId: handle.runId },
    isError: false,
  };
}

export function dispatchGetStatus(
  args: unknown,
  ctx: JobDispatchContext,
): McpToolResult {
  const jobId = parseJobId(args);
  if (typeof jobId !== "string") return jobId;
  const handle = ctx.runner.get(jobId);
  if (!handle) {
    return formatErrorResult(
      new McpServerError(ErrorCode.JOB_NOT_FOUND, `unknown jobId: ${jobId}`, {
        jobId,
      }),
    );
  }
  const snap = ctx.recorder.snapshot(jobId);
  const currentTask =
    handle.state === "awaiting-checkpoint" && handle.pendingCheckpoint
      ? {
          name: handle.pendingCheckpoint.taskName,
          kind: "checkpoint" as const,
          message: handle.pendingCheckpoint.message,
        }
      : snap?.lastTaskStart
        ? { name: snap.lastTaskStart.taskName, kind: "task" as const }
        : undefined;
  const progress = snap
    ? {
        tasksCompleted: snap.tasksCompleted,
        tasksTotal: ctx.taskCount,
        ...(snap.lastBudgetWarning !== undefined
          ? {
              spentUsd: snap.lastBudgetWarning.spentUsd,
              limitUsd: snap.lastBudgetWarning.limitUsd,
            }
          : {}),
      }
    : undefined;

  const structured = {
    state: handle.state,
    createdAt: handle.createdAt,
    lastEventAt: handle.lastEventAt,
    ...(currentTask !== undefined ? { currentTask } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

export function dispatchGetResult(
  args: unknown,
  ctx: JobDispatchContext,
): McpToolResult {
  const jobId = parseJobId(args);
  if (typeof jobId !== "string") return jobId;
  const handle = ctx.runner.get(jobId);
  if (!handle) {
    return formatErrorResult(
      new McpServerError(ErrorCode.JOB_NOT_FOUND, `unknown jobId: ${jobId}`, {
        jobId,
      }),
    );
  }

  if (handle.state === "running" || handle.state === "awaiting-checkpoint") {
    return {
      content: [{ type: "text", text: JSON.stringify({ pending: true }) }],
      structuredContent: { pending: true },
      isError: false,
    };
  }
  if (handle.state === "cancelled") {
    return formatErrorResult(
      new McpServerError(
        ErrorCode.JOB_CANCELLED,
        `job ${jobId} was cancelled`,
        { jobId },
      ),
    );
  }
  if (handle.state === "failed") {
    return formatErrorResult(
      new McpServerError(
        ErrorCode.WORKFLOW_FAILED,
        handle.error?.message ?? "workflow failed",
        { jobId, error: handle.error },
      ),
    );
  }
  // done — re-validate the output task's result through the output Zod schema.
  const raw = handle.result?.outputs[ctx.tool.outputTask];
  const outputTaskDef = ctx.workflow.tasks[ctx.tool.outputTask] as {
    agent: { output: import("zod").ZodType };
  };
  const parsedOutput = outputTaskDef.agent.output.safeParse(raw);
  if (!parsedOutput.success) {
    return formatErrorResult(
      new McpServerError(
        ErrorCode.OUTPUT_VALIDATION_FAILED,
        `schema validation failed: ${String(parsedOutput.error)}`,
        { error: parsedOutput.error },
      ),
    );
  }
  const structured = {
    state: "done" as const,
    output: parsedOutput.data,
    metrics: handle.result?.metrics,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured as Record<string, unknown>,
    isError: false,
  };
}

export function dispatchCancel(
  args: unknown,
  ctx: JobDispatchContext,
): McpToolResult {
  const jobId = parseJobId(args);
  if (typeof jobId !== "string") return jobId;
  const handle = ctx.runner.get(jobId);
  if (!handle) {
    return formatErrorResult(
      new McpServerError(ErrorCode.JOB_NOT_FOUND, `unknown jobId: ${jobId}`, {
        jobId,
      }),
    );
  }
  if (handle.state !== "running" && handle.state !== "awaiting-checkpoint") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ cancelled: false, priorState: handle.state }),
        },
      ],
      structuredContent: { cancelled: false, priorState: handle.state },
      isError: false,
    };
  }
  const priorState = handle.state;
  ctx.runner.cancel(jobId);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ cancelled: true, priorState }),
      },
    ],
    structuredContent: { cancelled: true, priorState },
    isError: false,
  };
}

export function dispatchResume(
  args: unknown,
  ctx: JobDispatchContext,
): McpToolResult {
  const parsed = parseResumeArgs(args);
  if ("isError" in parsed) return parsed;
  try {
    ctx.runner.resume(parsed.jobId, parsed.approved);
  } catch (err) {
    return formatErrorResult(err);
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ resumed: true }) }],
    structuredContent: { resumed: true },
    isError: false,
  };
}

/**
 * Parse jobId from args. Returns the string jobId or an error McpToolResult.
 */
function parseJobId(args: unknown): string | McpToolResult {
  if (
    typeof args !== "object" ||
    args === null ||
    typeof (args as { jobId?: unknown }).jobId !== "string"
  ) {
    return formatErrorResult(
      new McpServerError(ErrorCode.INPUT_VALIDATION_FAILED, "missing jobId", {
        args,
      }),
    );
  }
  return (args as { jobId: string }).jobId;
}

function parseResumeArgs(
  args: unknown,
): { jobId: string; approved: boolean } | McpToolResult {
  if (
    typeof args !== "object" ||
    args === null ||
    typeof (args as { jobId?: unknown }).jobId !== "string" ||
    typeof (args as { approved?: unknown }).approved !== "boolean"
  ) {
    return formatErrorResult(
      new McpServerError(
        ErrorCode.INPUT_VALIDATION_FAILED,
        "missing jobId or approved",
        { args },
      ),
    );
  }
  return args as { jobId: string; approved: boolean };
}

/** Factory used by server.ts to build the per-server dispatch context. */
export function createJobDispatchContext(args: {
  workflow: WorkflowDef;
  tool: ToolDefinition;
  jobTools: readonly ToolDefinition[];
  jobTtlMs?: number;
  jobCheckpointTtlMs?: number;
  releaseInflight: () => void;
}): JobDispatchContext {
  const runner = createRunner({
    ttlMs: args.jobTtlMs ?? 30 * 60_000,
    checkpointTtlMs: args.jobCheckpointTtlMs ?? 60 * 60_000,
  });
  return {
    runner,
    recorder: new JobEventRecorder(),
    workflow: args.workflow,
    tool: args.tool,
    jobTools: args.jobTools,
    taskCount: Object.keys(args.workflow.tasks).length,
    releaseInflight: args.releaseInflight,
  };
}

/**
 * Build the fully-composed workflow for a run by applying:
 * 1. Runtime input injection into the input task.
 * 2. Budget ceiling from effective ceilings (maxCostUsd).
 *
 * This mirrors makeDefaultRunner on the sync path so both paths produce
 * identical workflow budget configurations.
 *
 * HITL strategy is handled separately via DispatchStartOptions.onCheckpoint
 * passed to runner.fire() — NOT via workflow.hooks — because the executor's
 * stream() path uses "single-ownership": caller-provided onCheckpoint takes
 * full precedence and workflow.hooks.onCheckpoint is NOT called when a
 * stream-level onCheckpoint is present (see WorkflowExecutor docs).
 */
function applyRunOpts(
  workflow: WorkflowDef,
  inputTaskName: string,
  input: unknown,
  opts: DispatchStartOptions,
): WorkflowDef {
  // 1. Inject runtime input.
  // biome-ignore lint/suspicious/noExplicitAny: structural injection — task.input must be set at runtime
  const originalInputTask = workflow.tasks[inputTaskName] as any;
  const tasksWithInput = {
    ...workflow.tasks,
    [inputTaskName]: { ...originalInputTask, input },
  } as import("@ageflow/core").TasksMap;

  // 2. Apply budget ceiling (maxCostUsd only — maxTurns/maxDurationSec are
  // enforced via abortSignal / executor-level ceiling respectively).
  const budget =
    opts.effective.maxCostUsd !== null
      ? { maxCost: opts.effective.maxCostUsd, onExceed: "halt" as const }
      : undefined;

  return {
    ...workflow,
    tasks: tasksWithInput,
    ...(budget !== undefined ? { budget } : {}),
  };
}
