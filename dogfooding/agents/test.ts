import { defineAgent } from "@ageflow/core";
import { z } from "zod";

/**
 * TEST step — runs the test suite and reports results.
 * Paired with buildAgent in a loop: if tests fail, the loop continues
 * and buildAgent receives the failure as feedback.
 */
export const testAgent = defineAgent({
  runner: "claude",
  model: "claude-haiku-4-5-20251001",
  input: z.object({
    repoPath: z.string(),
    affectedPackages: z.array(z.string()),
    patch: z.string(),
  }),
  output: z.object({
    passed: z.boolean(),
    totalTests: z.number(),
    failedTests: z.number(),
    failureDetails: z.string().optional(), // error messages and stack traces
    lintErrors: z.string().optional(),
    typecheckErrors: z.string().optional(),
  }),
  prompt: ({ repoPath, affectedPackages, patch }) =>
    `You are a CI system. Run the test suite for this repository.

Repository: ${repoPath}
Affected packages: ${affectedPackages.join(", ")}

Changes applied:
${patch}

Run in this order:
1. bun run typecheck
2. bun run lint
3. bun run test

Return JSON with:
- passed: true if ALL checks passed
- totalTests: number of tests run
- failedTests: number of failures
- failureDetails: full error output if any tests failed (null if all passed)
- lintErrors: lint output if any (null if clean)
- typecheckErrors: typecheck output if any (null if clean)`,
  retry: {
    max: 1,
    on: ["subprocess_error"],
    backoff: "fixed",
  },
});
