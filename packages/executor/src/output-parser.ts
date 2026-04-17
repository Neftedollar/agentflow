import type { ZodType } from "zod";
import { OutputValidationError } from "./errors.js";

// Match the first fenced code block anywhere in the string (not anchored to start/end).
// This handles the common case where an agent wraps output in prose:
//   "Here's the result:\n\n```json\n{...}\n```"
const MARKDOWN_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/**
 * Parse agent raw stdout into typed output.
 *
 * Steps:
 * 1. Try JSON.parse(stdout)
 * 2. If fails: strip markdown code fences (```json...```) and retry
 * 3. schema.safeParse(parsed) → typed result or throw OutputValidationError
 *
 * Zod is the security boundary — raw stdout never passes through untransformed.
 */
export function parseAgentOutput<O extends ZodType>(
  stdout: string,
  schema: O,
  taskName: string,
): import("zod").infer<O> {
  const trimmed = stdout.trim();

  // Step 1: try direct JSON parse
  let parsed: unknown;
  let parseError: string | undefined;

  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);

    // Step 2: strip markdown fences and retry
    const fenceMatch = MARKDOWN_FENCE_RE.exec(trimmed);
    if (fenceMatch !== null) {
      const innerContent = fenceMatch[1];
      if (innerContent !== undefined) {
        try {
          parsed = JSON.parse(innerContent);
          parseError = undefined;
        } catch (e2) {
          parseError = e2 instanceof Error ? e2.message : String(e2);
        }
      }
    }
  }

  if (parseError !== undefined) {
    throw new OutputValidationError(
      taskName,
      `Could not parse JSON from agent output: ${parseError}`,
    );
  }

  // Step 3: Zod validation — security boundary
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new OutputValidationError(taskName, result.error.message);
  }

  return result.data as import("zod").infer<O>;
}
