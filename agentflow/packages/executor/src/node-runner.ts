import {
  AgentHitlConflictError,
  NodeMaxRetriesError,
  TimeoutError,
  resolveAgentDef,
} from "@agentflow/core";
import type { AgentDef, AttemptRecord, Runner, TaskDef } from "@agentflow/core";
import type { ZodType } from "zod";
import { OutputValidationError } from "./errors.js";
import { parseAgentOutput } from "./output-parser.js";

export interface NodeRunResult<O> {
  output: O;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  retries: number;
}

// ─── Input sanitization ───────────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /\n---\n/g,
  /\nSystem:/g,
  /\nHuman:/g,
  /\nAssistant:/g,
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

function calculateBackoffMs(backoff: "exponential" | "linear" | "fixed", attempt: number): number {
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
  resolvedInput: import("zod").infer<A extends { input: infer I extends ZodType } ? I : ZodType>,
  runner: Runner,
  taskName: string,
): Promise<NodeRunResult<import("zod").infer<A extends { output: infer O extends ZodType } ? O : ZodType>>> {
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
      const spawnArgs: import("@agentflow/core").RunnerSpawnArgs = { prompt };
      if (resolvedDef.model !== undefined) {
        spawnArgs.model = resolvedDef.model;
      }
      if (resolvedDef.tools !== undefined && resolvedDef.tools.length > 0) {
        spawnArgs.tools = resolvedDef.tools;
      }
      if (resolvedDef.mcps !== undefined && resolvedDef.mcps.length > 0) {
        spawnArgs.mcps = resolvedDef.mcps;
      }

      const spawnResult = await runner.spawn(spawnArgs);

      // Parse and validate output through Zod security boundary
      const output = parseAgentOutput(
        spawnResult.stdout,
        resolvedDef.output,
        taskName,
      ) as import("zod").infer<A extends { output: infer O extends ZodType } ? O : ZodType>;

      const latencyMs = Date.now() - startTime;

      return {
        output,
        tokensIn: spawnResult.tokensIn,
        tokensOut: spawnResult.tokensOut,
        latencyMs,
        retries: attempt,
      };
    } catch (err) {
      // HITL conflict — never retry, throw immediately
      if (err instanceof AgentHitlConflictError) {
        throw err;
      }

      // Determine if this error kind is retryable
      let errorCode: "subprocess_error" | "output_validation_error" | "timeout" | null = null;
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

        // Apply backoff before next attempt (not after last attempt)
        if (attempt < maxAttempts - 1) {
          const backoffMs = calculateBackoffMs(resolvedDef.retry.backoff, attempt);
          if (backoffMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
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
