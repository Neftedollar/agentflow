import type { WorkflowDef, WorkflowHooks } from "@ageflow/core";
import { resolveMcpConfig } from "@ageflow/core";
import { WorkflowExecutor } from "@ageflow/executor";
import { composeCeilings } from "./ceiling-resolver.js";
import {
  ErrorCode,
  McpServerError,
  type McpToolErrorResult,
  formatErrorResult,
} from "./errors.js";

/**
 * Tool names reserved by the async job observer layer.
 * Workflow names must not collide with these — see `createMcpServer`.
 */
export const ASYNC_OBSERVER_TOOL_NAMES = [
  "get_workflow_status",
  "get_workflow_result",
  "cancel_workflow",
  "resume_workflow",
] as const;
import { type McpConnectionLike, buildMcpHooks } from "./hitl-bridge.js";
import {
  type DispatchStartOptions,
  type JobDispatchContext,
  createJobDispatchContext,
  dispatchCancel,
  dispatchGetResult,
  dispatchGetStatus,
  dispatchResume,
  dispatchStart,
} from "./job-dispatch.js";
import { buildJobTools } from "./job-tools.js";
import { ProgressStreamer, type SendProgress } from "./progress-streamer.js";
import { type ToolDefinition, buildToolDefinition } from "./tool-registry.js";
import type { CliCeilings, EffectiveCeilings, HitlStrategy } from "./types.js";
import { DurationWatchdog } from "./watchdog.js";

export type RunWorkflowFn = (args: {
  workflow: WorkflowDef;
  input: unknown;
  hooks: unknown;
  signal: AbortSignal;
  effective: EffectiveCeilings;
}) => Promise<unknown>;

export interface McpServerOptions {
  readonly workflow: WorkflowDef;
  readonly cliCeilings: CliCeilings;
  readonly hitlStrategy: HitlStrategy;
  /** Opt-in async job mode. Default: false. */
  readonly async?: boolean;
  /** Override the default 30-minute job TTL (async mode only). */
  readonly jobTtlMs?: number;
  /** Override the default 1-hour checkpoint TTL (async mode only). */
  readonly jobCheckpointTtlMs?: number;
  /** Custom stderr writer (for testing); defaults to process.stderr.write. */
  readonly stderr?: (line: string) => void;
  /**
   * Executor runner. Defaults to calling `@ageflow/executor`'s WorkflowExecutor.
   * Injected for testing.
   */
  readonly runWorkflow?: RunWorkflowFn;
}

export interface McpToolSuccessResult {
  readonly content: readonly { type: "text"; text: string }[];
  readonly structuredContent: Record<string, unknown>;
  readonly isError: false;
}

export type McpToolResult = McpToolSuccessResult | McpToolErrorResult;

export interface McpServerHandle {
  listTools(): Promise<ToolDefinition[]>;
  callTool(
    name: string,
    args: unknown,
    opts?: {
      connection?: McpConnectionLike;
      progressToken?: string | number;
      sendProgress?: SendProgress;
    },
  ): Promise<McpToolResult>;
  /** Attached by tests only — replaces the real executor invocation. */
  _testRunExecutor?: (
    args: unknown,
    hooks: unknown,
    signal: AbortSignal,
    effective: EffectiveCeilings,
  ) => Promise<unknown>;
  /**
   * Test-only callback (async mode): called with the fully-composed workflow
   * just before runner.fire(). Lets tests assert ceiling / hook composition
   * without needing to intercept the executor itself.
   */
  _testOnComposedWorkflow?: (workflow: WorkflowDef) => void;
  /** Stop background TTL reaper (async mode only). Idempotent. */
  dispose?(): void;
}

/**
 * Compose an MCP server around a single workflow.
 *
 * The returned handle exposes listTools/callTool for wiring into the MCP
 * transport layer (stdio). A real implementation would forward these to
 * `@modelcontextprotocol/sdk`'s Server class; this minimal form is testable
 * directly without the transport.
 */
export function createMcpServer(opts: McpServerOptions): McpServerHandle {
  // Guard: in async mode the observer tools own fixed names. If the workflow
  // uses one of those names it would be unreachable (shadowed by observer
  // dispatch) and listTools would surface duplicates.
  if (opts.async === true) {
    const reserved = new Set<string>(ASYNC_OBSERVER_TOOL_NAMES);
    const wfName = opts.workflow.name;
    const startName = `start_${wfName}`;
    if (reserved.has(wfName) || reserved.has(startName)) {
      throw new McpServerError(
        ErrorCode.RESERVED_TOOL_NAME,
        `Workflow name "${wfName}" conflicts with a reserved async observer tool name. ` +
          `Reserved names: ${[...ASYNC_OBSERVER_TOOL_NAMES].join(", ")}`,
        { workflowName: wfName, reserved: [...ASYNC_OBSERVER_TOOL_NAMES] },
      );
    }
  }

  const resolved = resolveMcpConfig(opts.workflow.mcp);
  const stderr =
    opts.stderr ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const tool = buildToolDefinition(opts.workflow);
  const jobTools = opts.async === true ? buildJobTools(opts.workflow) : [];

  let inflight = false;
  let dispatchCtx: JobDispatchContext | undefined; // lazy — created on first start_*

  const startName = `start_${opts.workflow.name}`;
  const OBSERVER_TOOLS = new Set([
    "get_workflow_status",
    "get_workflow_result",
    "cancel_workflow",
    "resume_workflow",
  ]);

  function ensureDispatchCtx(): JobDispatchContext {
    if (!dispatchCtx) {
      dispatchCtx = createJobDispatchContext({
        workflow: opts.workflow,
        tool,
        jobTools,
        ...(opts.jobTtlMs !== undefined ? { jobTtlMs: opts.jobTtlMs } : {}),
        ...(opts.jobCheckpointTtlMs !== undefined
          ? { jobCheckpointTtlMs: opts.jobCheckpointTtlMs }
          : {}),
        releaseInflight: () => {
          inflight = false;
        },
      });
    }
    return dispatchCtx;
  }

  const handle: McpServerHandle = {
    async listTools() {
      return opts.async === true ? [tool, ...jobTools] : [tool];
    },

    dispose() {
      dispatchCtx?.runner.close();
    },

    async callTool(name, args, callOpts) {
      const isSync = name === tool.name;
      const isStart = opts.async === true && name === startName;
      const isObserver = opts.async === true && OBSERVER_TOOLS.has(name);

      if (!isSync && !isStart && !isObserver) {
        // Return ASYNC_MODE_DISABLED for job tools when async=false
        if (name === startName || OBSERVER_TOOLS.has(name)) {
          return formatErrorResult(
            new McpServerError(
              ErrorCode.ASYNC_MODE_DISABLED,
              `async mode is disabled; tool "${name}" is unavailable`,
              { name },
            ),
          );
        }
        return formatErrorResult(
          new McpServerError(
            ErrorCode.WORKFLOW_FAILED,
            `unknown tool: ${name}`,
            { name },
          ),
        );
      }

      // Observer tools: no inflight lock.
      if (isObserver) {
        const ctx = ensureDispatchCtx();
        switch (name) {
          case "get_workflow_status":
            return dispatchGetStatus(args, ctx);
          case "get_workflow_result":
            return dispatchGetResult(args, ctx);
          case "cancel_workflow":
            return dispatchCancel(args, ctx);
          case "resume_workflow":
            return dispatchResume(args, ctx);
        }
      }

      // start_* and sync tool: share the inflight lock.
      if (inflight) {
        return formatErrorResult(
          new McpServerError(
            ErrorCode.BUSY,
            "Another workflow run is in progress",
          ),
        );
      }
      inflight = true;

      if (isStart) {
        const ctx = ensureDispatchCtx();
        // Thread test hooks into context (test-only).
        if (handle._testOnComposedWorkflow !== undefined) {
          ctx._testOnComposedWorkflow = handle._testOnComposedWorkflow;
        }
        // Thread test executor into context if set on handle (wraps 4-arg to 1-arg)
        if (handle._testRunExecutor !== undefined) {
          const testExec = handle._testRunExecutor;
          ctx.testRunExecutor = (input: unknown) =>
            testExec(
              input,
              undefined,
              new AbortController().signal,
              {} as EffectiveCeilings,
            );
        }

        // Apply the same ceiling/hook composition as the sync path so that
        // async jobs respect CLI ceiling overrides and the configured HITL strategy.
        const asyncEffective = composeCeilings(
          resolved,
          opts.cliCeilings,
          stderr,
        );

        // DurationWatchdog for async: instead of Promise.race (which requires
        // awaiting the run), we wire an AbortController into runner.fire() via
        // the `signal` option. When maxDurationSec elapses the signal fires,
        // the internal executor stream receives it, and the run is cancelled.
        // This is semantically equivalent to the sync watchdog (both abort the
        // underlying executor) but adapted for fire-and-forget execution.
        // Note: the run will appear as "cancelled" (not "duration-exceeded") in
        // the job registry, which is the correct terminal state for async jobs
        // that hit their duration ceiling. A finer-grained DURATION_EXCEEDED
        // status is left as a follow-up (tracked in #84 item 11).
        let asyncWatchdogSignal: AbortSignal | undefined;
        if (asyncEffective.maxDurationSec !== null) {
          const asyncWatchdog = new DurationWatchdog(
            asyncEffective.maxDurationSec,
            () => {},
          );
          asyncWatchdog.start();
          asyncWatchdogSignal = asyncWatchdog.abortSignal;
        }

        // Derive async HITL strategy: map hitlStrategy to a simple checkpoint
        // resolver for runner.fire(). The async path cannot use MCP elicitation
        // (no persistent connection during fire-and-forget execution), so:
        //   "auto"   → immediately approve
        //   "fail"   → immediately reject
        //   "elicit" → undefined (runner's deferred path; client uses resume_workflow)
        const asyncOnCheckpoint: DispatchStartOptions["onCheckpoint"] =
          opts.hitlStrategy === "auto"
            ? () => true
            : opts.hitlStrategy === "fail"
              ? () => false
              : undefined; // elicit → deferred resume_workflow mechanism

        const dispatchOpts: DispatchStartOptions = {
          effective: asyncEffective,
          ...(asyncOnCheckpoint !== undefined
            ? { onCheckpoint: asyncOnCheckpoint }
            : {}),
          ...(asyncWatchdogSignal !== undefined
            ? { abortSignal: asyncWatchdogSignal }
            : {}),
        };

        // dispatchStart releases inflight via ctx.releaseInflight (onComplete/onError)
        // or on validation failure.
        return await dispatchStart(name, args, ctx, dispatchOpts);
      }

      // Sync path (existing body) — inflight cleared in finally.
      try {
        // Validate input
        const inputTaskDef = (opts.workflow.tasks as Record<string, unknown>)[
          tool.inputTask
        ] as {
          agent: {
            input: {
              safeParse: (v: unknown) => {
                success: boolean;
                data?: unknown;
                error?: unknown;
              };
            };
          };
        };
        const parsedInput = safeParse(
          inputTaskDef.agent.input,
          args,
          ErrorCode.INPUT_VALIDATION_FAILED,
        );

        // Effective ceilings
        const effective = composeCeilings(resolved, opts.cliCeilings, stderr);

        // Progress streamer
        const streamer = new ProgressStreamer(
          callOpts?.sendProgress ?? (() => {}),
          callOpts?.progressToken,
        );

        // Emit unlimited warnings
        const unlimitedAxes: string[] = [];
        if (effective.maxCostUsd === null) unlimitedAxes.push("cost");
        if (effective.maxDurationSec === null) unlimitedAxes.push("duration");
        if (effective.maxTurns === null) unlimitedAxes.push("turns");
        if (unlimitedAxes.length > 0) streamer.unlimitedWarning(unlimitedAxes);

        // Watchdog — side-effect only; abort is communicated via abortPromise race
        const watchdog = new DurationWatchdog(effective.maxDurationSec, () => {
          // intentionally empty: AbortController.abort() is called by DurationWatchdog
          // internally; consumers race against abortPromise below
        });
        watchdog.start();

        const abortPromise = new Promise<never>((_, reject) => {
          watchdog.abortSignal.addEventListener("abort", () => {
            reject(
              new McpServerError(
                ErrorCode.DURATION_EXCEEDED,
                `workflow exceeded maxDurationSec=${effective.maxDurationSec}`,
                { maxDurationSec: effective.maxDurationSec },
              ),
            );
          });
        });

        // HITL bridge (requires MCP connection)
        const mcpHooks =
          callOpts?.connection !== undefined
            ? buildMcpHooks(
                callOpts.connection,
                opts.hitlStrategy,
                (taskName, message) =>
                  streamer.awaitingElicitation(taskName, message),
                opts.workflow.hooks?.onCheckpoint,
              )
            : undefined;

        // Run executor (Task 13: real executor or pluggable injection)
        let rawOutput: unknown;
        if (handle._testRunExecutor !== undefined) {
          rawOutput = await Promise.race([
            handle._testRunExecutor(
              parsedInput,
              mcpHooks,
              watchdog.abortSignal,
              effective,
            ),
            abortPromise,
          ]);
        } else {
          const runner =
            opts.runWorkflow ??
            makeDefaultRunner(tool.inputTask, tool.outputTask);
          rawOutput = await Promise.race([
            runner({
              workflow: opts.workflow,
              input: parsedInput,
              hooks: mcpHooks,
              signal: watchdog.abortSignal,
              effective,
            }),
            abortPromise,
          ]);
        }
        watchdog.cancel();

        // Validate output
        const outputTaskDef = (opts.workflow.tasks as Record<string, unknown>)[
          tool.outputTask
        ] as {
          agent: {
            output: {
              safeParse: (v: unknown) => {
                success: boolean;
                data?: unknown;
                error?: unknown;
              };
            };
          };
        };
        const parsedOutput = safeParse(
          outputTaskDef.agent.output,
          rawOutput,
          ErrorCode.OUTPUT_VALIDATION_FAILED,
        );

        return {
          content: [{ type: "text", text: JSON.stringify(parsedOutput) }],
          structuredContent: parsedOutput as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        return formatErrorResult(err);
      } finally {
        inflight = false;
      }
    },
  };

  return handle;
}

function safeParse(
  schema: {
    safeParse: (v: unknown) => {
      success: boolean;
      data?: unknown;
      error?: unknown;
    };
  },
  value: unknown,
  errorCode: (typeof ErrorCode)[keyof typeof ErrorCode],
): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new McpServerError(
      errorCode,
      `schema validation failed: ${String(result.error)}`,
      { error: result.error },
    );
  }
  return result.data;
}

/**
 * Build the default RunWorkflowFn backed by @ageflow/executor's WorkflowExecutor.
 *
 * Real API deviations from plan pseudocode:
 * - No `runWorkflow` function export — WorkflowExecutor is a class.
 * - WorkflowExecutor.run() ignores its `_input` argument; input must be injected
 *   into the workflow's root task definition as a static `input` field.
 * - Budget is passed via workflow.budget (BudgetConfig), not as a run-time arg.
 * - HITL hooks are passed via workflow.hooks (merged with existing hooks).
 * - AbortSignal is not natively supported; the DurationWatchdog's onTimeout
 *   callback throws into the awaited run(), which propagates as a rejection.
 */
function makeDefaultRunner(
  inputTaskName: string,
  outputTaskName: string,
): RunWorkflowFn {
  return async (args) => {
    const { workflow, input, hooks, effective } = args;

    // Inject MCP input as the root task's static input field.
    // biome-ignore lint/suspicious/noExplicitAny: structural injection — task.input must be set at runtime
    const originalTask = workflow.tasks[inputTaskName] as any;
    const injectedTasks = {
      ...workflow.tasks,
      [inputTaskName]: { ...originalTask, input },
    } as import("@ageflow/core").TasksMap;

    // Merge HITL hooks with existing workflow hooks.
    const mcpHooks = hooks as WorkflowHooks | undefined;
    const mergedHooks: WorkflowHooks = {
      ...(workflow.hooks ?? {}),
      ...(mcpHooks !== undefined ? mcpHooks : {}),
    };

    // Apply budget ceiling from effective config.
    const budget =
      effective.maxCostUsd !== null
        ? { maxCost: effective.maxCostUsd, onExceed: "halt" as const }
        : undefined;

    const injectedWorkflow: WorkflowDef = {
      ...workflow,
      tasks: injectedTasks,
      hooks: mergedHooks,
      ...(budget !== undefined ? { budget } : {}),
    };

    const executor = new WorkflowExecutor(injectedWorkflow);
    const result = await executor.run();

    // Return the output task's result.
    return result.outputs[outputTaskName];
  };
}
