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
import { type McpConnectionLike, buildMcpHooks } from "./hitl-bridge.js";
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
  const resolved = resolveMcpConfig(opts.workflow.mcp);
  const stderr =
    opts.stderr ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const tool = buildToolDefinition(opts.workflow);

  let inflight = false;

  const handle: McpServerHandle = {
    async listTools() {
      return [tool];
    },

    async callTool(name, args, callOpts) {
      if (name !== tool.name) {
        return formatErrorResult(
          new McpServerError(
            ErrorCode.WORKFLOW_FAILED,
            `unknown tool: ${name}`,
            { name },
          ),
        );
      }

      if (inflight) {
        return formatErrorResult(
          new McpServerError(
            ErrorCode.BUSY,
            "Another workflow run is in progress",
          ),
        );
      }
      inflight = true;

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
