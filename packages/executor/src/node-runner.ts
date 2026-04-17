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

/**
 * Optional arguments to runNode — grouped into a single object to prevent
 * positional-argument mis-alignment when new options are added.
 *
 * Defensive default for hitlEnforcing:
 *   - When filteredTools is provided and hitlEnforcing is undefined → behaves
 *     as hitlEnforcing: true (preserves 0.6.1 strict enforcement; protects
 *     legacy callers from HITL bypass regression).
 *   - Only when hitlEnforcing is explicitly false does the filter skip.
 *   - When filteredTools is undefined → no filter regardless of hitlEnforcing.
 */
export interface RunNodeOpts {
  /** Workflow / task hooks (getSystemPromptPrefix, etc.). */
  // biome-ignore lint/suspicious/noExplicitAny: hooks generic T not available here
  hooks?: WorkflowHooks<any>;
  /** Boolean permission map forwarded to the runner. */
  permissions?: Record<string, boolean>;
  /**
   * HITL-approved tool allowlist. When provided without an explicit
   * hitlEnforcing value the filter is applied (defensive default = enforcing).
   */
  filteredTools?: readonly string[];
  /**
   * Whether HITL is actively enforcing the tool allowlist.
   *
   * - true  → intersection of candidates with filteredTools is applied.
   * - false → filter skipped; all candidate tools pass through unchanged.
   * - undefined (default) → behaves as true when filteredTools is provided,
   *   false otherwise.
   */
  hitlEnforcing?: boolean;
  /** Callback invoked before each retry attempt. */
  onRetry?: (attempt: number, reason: string) => void;
  /** Workflow-level MCP server configs. */
  workflowMcpServers?: readonly McpServerConfig[];
  /** Per-runner overrides (session handle, inline tools). */
  runnerOverrides?: RunnerOverrides;
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
  opts?: RunNodeOpts,
): Promise<
  NodeRunResult<
    import("zod").infer<
      A extends { output: infer O extends ZodType } ? O : ZodType
    >
  >
> {
  // Destructure opts with defaults
  const {
    hooks,
    permissions,
    filteredTools,
    hitlEnforcing,
    onRetry,
    workflowMcpServers,
    runnerOverrides,
  } = opts ?? {};

  // Defensive default: when filteredTools is provided and hitlEnforcing is
  // not explicitly set, treat as enforcing (preserves 0.6.1 strict behavior
  // and protects legacy callers from HITL bypass regression).
  const effectiveHitlEnforcing =
    hitlEnforcing !== undefined ? hitlEnforcing : filteredTools !== undefined;

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

      // ── String[] allowlist for tools ────────────────────────────────────────
      // Step 1: Build the base allowlist from the agent definition (no HITL yet).
      let baseToolNames: readonly string[] | undefined;
      if (Array.isArray(resolvedDef.tools)) {
        baseToolNames = resolvedDef.tools as readonly string[];
      } else if (resolvedDef.tools !== undefined) {
        // Inline map — keys are the allowlist
        baseToolNames = Object.keys(
          resolvedDef.tools as Record<string, InlineToolDef>,
        );
      }

      // Step 2: Merge per-call inline tool names into the candidate set BEFORE
      // HITL filtering.  Per-call names are only allowed through if HITL permits
      // them (i.e. their name appears in filteredTools).
      const perCallNames =
        perCallInlineTools !== undefined ? Object.keys(perCallInlineTools) : [];

      // Candidate set: agent tools + per-call tools (deduped)
      let candidateToolNames: readonly string[] | undefined;
      if (baseToolNames !== undefined || perCallNames.length > 0) {
        const seen = new Set<string>(baseToolNames ?? []);
        for (const n of perCallNames) {
          seen.add(n);
        }
        candidateToolNames = [...seen];
      }

      // Step 3: Apply HITL filter.
      // - If effectiveHitlEnforcing is true (mode === "permissions"), filteredTools is
      //   the authoritative set.  Any candidate not in filteredTools is dropped —
      //   including per-call overrides.  An empty filteredTools means deny-all.
      // - If effectiveHitlEnforcing is false (HITL off or checkpoint-only),
      //   all candidates pass through unchanged.
      let effectiveToolNames: readonly string[] | undefined;
      if (effectiveHitlEnforcing === true && filteredTools !== undefined) {
        // HITL is actively enforcing: intersect candidates with the HITL-approved set.
        // candidateToolNames may be undefined when the agent has no tools; in
        // that case effectiveToolNames takes the HITL value directly (which may
        // be [] — deny-all).
        const hitlSet = new Set<string>(filteredTools);
        if (candidateToolNames !== undefined) {
          effectiveToolNames = candidateToolNames.filter((n) => hitlSet.has(n));
        } else {
          // No agent/per-call tools — HITL provides the allowlist (may be []).
          effectiveToolNames = filteredTools;
        }
      } else {
        effectiveToolNames = candidateToolNames;
      }

      // Step 4: Build inlineTools map filtered to effectiveToolNames.
      // Only include inline defs whose names survived HITL filtering.
      let mergedInlineTools:
        | Readonly<Record<string, InlineToolDef>>
        | undefined;
      if (agentInlineTools !== undefined || perCallInlineTools !== undefined) {
        const unfiltered: Record<string, InlineToolDef> = {
          ...(agentInlineTools ?? {}),
          ...(perCallInlineTools ?? {}),
        };
        if (effectiveToolNames !== undefined) {
          const allowed = new Set<string>(effectiveToolNames);
          const filtered: Record<string, InlineToolDef> = {};
          for (const [name, def] of Object.entries(unfiltered)) {
            if (allowed.has(name)) {
              filtered[name] = def;
            }
          }
          mergedInlineTools =
            Object.keys(filtered).length > 0 ? filtered : undefined;
        } else {
          mergedInlineTools = unfiltered;
        }
      }

      if (mergedInlineTools !== undefined) {
        spawnArgs.inlineTools = mergedInlineTools;
      }

      // Step 5: Set tools allowlist.
      // SECURITY: always set spawnArgs.tools when effectiveToolNames is defined —
      // even when the list is empty (deny-all).  Skipping the assignment when
      // length === 0 would leave the runner without a tools constraint, causing
      // it to default to "all tools available" and silently turning a deny-all
      // into an allow-all.
      if (effectiveToolNames !== undefined) {
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

      // Pass permissions if available (from opts.permissions)
      if (permissions !== undefined) {
        spawnArgs.permissions = permissions;
      }

      // Fire onTaskSpawnArgs hook (best-effort — errors must not crash the task)
      try {
        hooks?.onTaskSpawnArgs?.(taskName, spawnArgs);
      } catch (hookErr) {
        console.warn(
          "[agentflow] onTaskSpawnArgs hook error for task %s:",
          taskName,
          hookErr,
        );
      }

      const spawnResult = await runner.spawn(spawnArgs);

      // Fire onTaskSpawnResult hook (best-effort — errors must not crash the task)
      try {
        hooks?.onTaskSpawnResult?.(taskName, spawnResult);
      } catch (hookErr) {
        console.warn(
          "[agentflow] onTaskSpawnResult hook error for task %s:",
          taskName,
          hookErr,
        );
      }

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
