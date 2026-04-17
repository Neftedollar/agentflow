import {
  AgentHitlConflictError,
  NodeMaxRetriesError,
  TimeoutError,
  resolveAgentDef,
} from "@ageflow/core";
import type {
  AgentDef,
  AttemptRecord,
  InlineToolDef,
  McpServerConfig,
  Runner,
  RunnerOverrides,
  TaskDef,
  WorkflowHooks,
} from "@ageflow/core";
import type { ZodType } from "zod";
import { OutputValidationError } from "./errors.js";
import { expandServerEnv } from "./mcp-env.js";
import { parseAgentOutput } from "./output-parser.js";
import { resolveMcp } from "./resolve-mcp.js";
import { buildOutputSchemaPrompt } from "./schema-prompt.js";

export interface NodeRunResult<O> {
  output: O;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  retries: number;
  sessionHandle: string;
  /** The full prompt as sent to the runner (systemPrompt + user prompt). */
  promptSent: string;
}

// ─── Input sanitization ───────────────────────────────────────────────────────

// Patterns cover first-line injection ((?:^|\n)), leading whitespace (\s*),
// and case variants (i flag). Zod is the primary security boundary; this is
// a best-effort defense against prompt injection in string leaf values.
const INJECTION_PATTERNS = [
  /(?:^|\n)\s*---\s*(?:\n|$)/gm,
  /(?:^|\n)\s*System:/gim,
  /(?:^|\n)\s*Human:/gim,
  /(?:^|\n)\s*Assistant:/gim,
];

/**
 * Recursively sanitize string values in an object against prompt injection patterns.
 * Only string leaf values are sanitized — objects and arrays are traversed.
 */
function sanitizeCtxData(data: unknown): unknown {
  if (typeof data === "string") {
    let sanitized = data;
    for (const pattern of INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, " [SANITIZED] ");
    }
    return sanitized;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeCtxData);
  }

  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = sanitizeCtxData(value);
    }
    return result;
  }

  return data;
}

// ─── Backoff calculation ──────────────────────────────────────────────────────

function calculateBackoffMs(
  backoff: "exponential" | "linear" | "fixed",
  attempt: number,
): number {
  switch (backoff) {
    case "exponential": {
      const ms = 2 ** attempt * 1000;
      return Math.min(ms, 30_000);
    }
    case "linear":
      return attempt * 1000;
    case "fixed":
      return 1000;
  }
}

// ─── runNode ──────────────────────────────────────────────────────────────────

/**
 * Run a single task with retry logic.
 * Retries on: subprocess_error, output_validation_error, timeout.
 * Throws NodeMaxRetriesError after max attempts.
 * AgentHitlConflictError is never retried.
 */
export async function runNode<
  // biome-ignore lint/suspicious/noExplicitAny: structural constraint
  A extends AgentDef<any, any, any>,
>(
  task: TaskDef<A>,
  resolvedInput: import("zod").infer<
    A extends { input: infer I extends ZodType } ? I : ZodType
  >,
  runner: Runner,
  taskName: string,
  sessionHandle?: string,
  permissions?: Record<string, boolean>,
  filteredTools?: readonly string[],
  onRetry?: (attempt: number, reason: string) => void,
  workflowMcpServers?: readonly McpServerConfig[],
  // biome-ignore lint/suspicious/noExplicitAny: hooks generic T not available here
  hooks?: WorkflowHooks<any>,
  runnerOverrides?: RunnerOverrides,
): Promise<
  NodeRunResult<
    import("zod").infer<
      A extends { output: infer O extends ZodType } ? O : ZodType
    >
  >
> {
  const resolvedDef = resolveAgentDef(task.agent);
  const maxAttempts = resolvedDef.retry.max;
  const attempts: AttemptRecord[] = [];
  const startTime = Date.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Apply prompt injection sanitization if enabled
      const safeInput = resolvedDef.sanitizeInput
        ? (sanitizeCtxData(resolvedInput) as typeof resolvedInput)
        : resolvedInput;

      const prompt = resolvedDef.prompt(safeInput);

      // Build spawn args — only include optional properties when defined
      // (exactOptionalPropertyTypes requires we not pass explicit undefined)
      const baseSystemPrompt = buildOutputSchemaPrompt(resolvedDef.output);
      const prefix = await hooks?.getSystemPromptPrefix?.(taskName);
      const systemPrompt = prefix
        ? `${prefix}\n\n${baseSystemPrompt}`
        : baseSystemPrompt;
      const spawnArgs: import("@ageflow/core").RunnerSpawnArgs = {
        prompt,
        taskName,
        systemPrompt,
      };
      if (resolvedDef.model !== undefined) {
        spawnArgs.model = resolvedDef.model;
      }

      // ── Resolve per-runner overrides ────────────────────────────────────────
      const runnerBrand: string = resolvedDef.runner;
      const overridesForRunner = runnerOverrides?.[runnerBrand];

      // ── Inline tools: build inlineTools map for spawn args ──────────────────
      // Precedence: per-call (runnerOverrides) > per-agent (AgentDef inline map) > per-instance
      // The runner merges them with instance tools internally.
      const agentInlineTools = Array.isArray(resolvedDef.tools)
        ? undefined
        : (resolvedDef.tools as
            | Readonly<Record<string, InlineToolDef>>
            | undefined);

      const perCallInlineTools = overridesForRunner?.tools;

      // Build the merged inline map that goes into spawnArgs.inlineTools
      let mergedInlineTools:
        | Readonly<Record<string, InlineToolDef>>
        | undefined;
      if (agentInlineTools !== undefined || perCallInlineTools !== undefined) {
        mergedInlineTools = {
          ...(agentInlineTools ?? {}),
          ...(perCallInlineTools ?? {}),
        };
      }

      if (mergedInlineTools !== undefined) {
        spawnArgs.inlineTools = mergedInlineTools;
      }

      // ── String[] allowlist for tools ────────────────────────────────────────
      // If filteredTools (HITL) is provided, use it.
      // Otherwise: if agent tools is string[], use that; if inline map, use its keys.
      // If per-call inline tools exist, append their names to the allowlist.
      let effectiveToolNames: readonly string[] | undefined;
      if (filteredTools !== undefined) {
        // HITL-filtered — already a string[]
        effectiveToolNames = filteredTools;
      } else if (Array.isArray(resolvedDef.tools)) {
        effectiveToolNames = resolvedDef.tools as readonly string[];
      } else if (resolvedDef.tools !== undefined) {
        // Inline map — keys are the allowlist
        effectiveToolNames = Object.keys(
          resolvedDef.tools as Record<string, InlineToolDef>,
        );
      }

      // Merge per-call inline tool names into allowlist
      if (
        perCallInlineTools !== undefined &&
        Object.keys(perCallInlineTools).length > 0
      ) {
        const perCallNames = Object.keys(perCallInlineTools);
        if (effectiveToolNames !== undefined) {
          effectiveToolNames = [...effectiveToolNames, ...perCallNames];
        } else {
          effectiveToolNames = perCallNames;
        }
      }

      if (effectiveToolNames !== undefined && effectiveToolNames.length > 0) {
        spawnArgs.tools = effectiveToolNames;
      }

      // Resolve MCP servers: merge workflow + agent + task override, then expand env vars.
      const resolved = resolveMcp(
        workflowMcpServers,
        resolvedDef.mcp,
        task.mcpOverride,
      );
      if (resolved.length > 0) {
        spawnArgs.mcpServers = resolved.map((s) =>
          expandServerEnv(s, process.env as Record<string, string>),
        );
      }

      // Deprecated alias retained for one release cycle.
      if (resolvedDef.mcps !== undefined && resolvedDef.mcps.length > 0) {
        spawnArgs.mcps = resolvedDef.mcps;
      }

      // Pass session handle if available (runnerOverrides.sessionHandle wins over arg)
      const effectiveSessionHandle =
        overridesForRunner?.sessionHandle ?? sessionHandle;
      if (
        effectiveSessionHandle !== undefined &&
        effectiveSessionHandle !== ""
      ) {
        spawnArgs.sessionHandle = effectiveSessionHandle;
      }

      // Pass permissions if available
      if (permissions !== undefined) {
        spawnArgs.permissions = permissions;
      }

      const spawnResult = await runner.spawn(spawnArgs);

      // Parse and validate output through Zod security boundary
      const output = parseAgentOutput(
        spawnResult.stdout,
        resolvedDef.output,
        taskName,
      ) as import("zod").infer<
        A extends { output: infer O extends ZodType } ? O : ZodType
      >;

      const latencyMs = Date.now() - startTime;

      return {
        output,
        tokensIn: spawnResult.tokensIn,
        tokensOut: spawnResult.tokensOut,
        latencyMs,
        retries: attempt,
        sessionHandle: spawnResult.sessionHandle,
        promptSent: `${systemPrompt}\n\n${prompt}`,
      };
    } catch (err) {
      // HITL conflict — never retry. Runners emit "unknown" as the task name
      // because they don't know it; substitute the real taskName here.
      if (err instanceof AgentHitlConflictError) {
        throw new AgentHitlConflictError(taskName, { cause: err });
      }

      // Determine if this error kind is retryable
      let errorCode:
        | "subprocess_error"
        | "output_validation_error"
        | "timeout"
        | null = null;
      let errorMessage: string;

      if (err instanceof OutputValidationError) {
        errorCode = "output_validation_error";
        errorMessage = err.message;
      } else if (err instanceof TimeoutError) {
        errorCode = "timeout";
        errorMessage = err.message;
      } else if (err instanceof Error && err.message.includes("subprocess")) {
        errorCode = "subprocess_error";
        errorMessage = err.message;
      } else if (err instanceof Error) {
        // Check if the error has a code that matches a subprocess error
        const errWithCode = err as Error & { code?: string };
        if (errWithCode.code === "subprocess_error") {
          errorCode = "subprocess_error";
          errorMessage = err.message;
        } else {
          // Unknown error — throw immediately without retry
          throw err;
        }
      } else {
        throw err;
      }

      // Check if this error kind is in the retry list
      if (errorCode !== null && resolvedDef.retry.on.includes(errorCode)) {
        attempts.push({
          attempt,
          error: errorMessage,
          errorCode,
        });

        // Apply backoff before next attempt (not after last attempt).
        // Only fire onRetry when another attempt will actually happen.
        if (attempt < maxAttempts - 1) {
          // Notify caller about the upcoming retry attempt
          onRetry?.(attempt + 1, errorMessage);
          const backoffMs = calculateBackoffMs(
            resolvedDef.retry.backoff,
            attempt,
          );
          if (backoffMs > 0) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, backoffMs),
            );
          }
        }
      } else {
        // Error not in retry list — throw immediately
        throw err;
      }
    }
  }

  throw new NodeMaxRetriesError(taskName, attempts);
}
