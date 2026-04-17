import { defineAgent } from "@ageflow/core";
import { z } from "zod";

const findingSchema = z.object({
  severity: z.enum(["critical", "major", "minor", "suggestion"]),
  file: z.string(),
  description: z.string(),
  suggestion: z.string().optional(),
});

/**
 * VERIFY step — code review + reality check (parallel in the workflow).
 * Checks: correctness, security, adherence to plan, no regressions.
 * Returns APPROVED or NEEDS_WORK with specific findings.
 */
export const verifyAgent = defineAgent({
  runner: "claude",
  model: "claude-opus-4-6",
  input: z.object({
    patch: z.string(),
    filesChanged: z.array(z.string()),
    explanation: z.string(),
    acceptanceCriteria: z.array(z.string()),
    testResults: z.object({
      passed: z.boolean(),
      totalTests: z.number(),
      failedTests: z.number(),
    }),
  }),
  output: z.object({
    verdict: z.enum(["APPROVED", "NEEDS_WORK"]),
    findings: z.array(findingSchema),
    securityIssues: z.array(z.string()),
    acceptanceCriteriaStatus: z.array(
      z.object({
        criterion: z.string(),
        met: z.boolean(),
        evidence: z.string(),
      }),
    ),
    summary: z.string(),
  }),
  prompt: ({ patch, explanation, acceptanceCriteria, testResults }) =>
    `You are a senior code reviewer. Review these changes with zero tolerance for security issues.

Changes:
${patch}

Developer's explanation:
${explanation}

Test results: ${testResults.passed ? "✅ All passing" : `❌ ${testResults.failedTests}/${testResults.totalTests} failing`}

Acceptance criteria to verify:
${acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

Review for:
1. Correctness and logic errors
2. Security vulnerabilities (injection, path traversal, auth bypass, hardcoded secrets)
3. Each acceptance criterion — is it actually met?
4. Breaking changes or regressions

Return JSON:
- verdict: "APPROVED" | "NEEDS_WORK"
- findings: array of { severity, file, description, suggestion? }
- securityIssues: list any security problems (empty array if none)
- acceptanceCriteriaStatus: for each criterion: { criterion, met, evidence }
- summary: one paragraph review summary`,
  retry: {
    max: 2,
    on: ["subprocess_error", "output_validation_error"],
    backoff: "exponential",
  },
});
