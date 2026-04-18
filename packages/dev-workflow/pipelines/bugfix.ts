// Bugfix pipeline — TRIAGE → REPRODUCE → FIX → TEST → VERIFY → SHIP.
//
// Sub-PR 4: all 5 remaining noop nodes are now real implementations:
//   triage    — defineFunction: label-based severity + @ageflow/* detection
//   reproduce — defineAgent(engineering-senior-developer, codex): writes failing test
//   fix       — defineAgent(engineering-senior-developer, codex) + session continuation
//   test      — defineFunction: bun test spawn (same pattern as PR C)
//   ship      — defineFunction: git + gh pr create with `fix:` prefix
//
//   verify    — real defineAgent(testing-reality-checker, codex) ✅ (from sub-PR 2)
//
// Session design: `reproduce` and `fix` share a sessionToken("bugfix", "codex")
// so the fix agent has full conversation context from the reproduce conversation.

import {
  defineAgent,
  defineFunction,
  defineWorkflowFactory,
  sessionToken,
} from "@ageflow/core";
import { execa } from "execa";
import { z } from "zod";
import { loadRoleSync } from "../shared/role-loader.js";
import type { WorkflowInput } from "../shared/types.js";

// Shared session token — reproduce + fix share the same codex conversation.
const bugfixSession = sessionToken("bugfix", "codex");

// TRIAGE — deterministic label classifier. No LLM call.
// Derives severity from issue labels; extracts @ageflow/* package mentions
// from the issue body. Fallback: affectedPackages = [] (architect fills in).
const triageFn = defineFunction({
  name: "triage",
  input: z.object({
    issueNumber: z.number().int().positive(),
    labels: z.array(z.string()),
    issueBody: z.string(),
  }),
  output: z.object({
    severity: z.enum(["critical", "high", "medium", "low"]),
    affectedPackages: z.array(z.string()),
  }),
  execute: async (input) => {
    const labelLower = input.labels.map((l) => l.toLowerCase());

    let severity: "critical" | "high" | "medium" | "low" = "medium";
    if (labelLower.includes("critical") || labelLower.includes("security")) {
      severity = "critical";
    } else if (
      labelLower.includes("high") ||
      labelLower.includes("regression")
    ) {
      severity = "high";
    } else if (labelLower.includes("low") || labelLower.includes("minor")) {
      severity = "low";
    }

    // Grep issue body for @ageflow/* mentions; deduplicate.
    const pkgMatches = input.issueBody.match(/@ageflow\/[a-z-]+/g) ?? [];
    const affectedPackages = [...new Set(pkgMatches)];

    return { severity, affectedPackages };
  },
});

// REPRODUCE — senior-developer writes a failing test that captures the bug.
// Output: test file path + describe block name + the failing output.
const reproduceAgent = defineAgent({
  runner: "codex",
  input: z.object({
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    issueBody: z.string(),
    affectedPackages: z.array(z.string()),
    worktreePath: z.string(),
  }),
  output: z.object({
    testFilePath: z.string(),
    describeBlock: z.string(),
    failingOutput: z.string(),
  }),
  prompt: (input) => {
    const role = loadRoleSync("engineering-senior-developer");
    return [
      role.body,
      "---",
      `Bugfix issue #${input.issueNumber}: ${input.issueTitle}`,
      input.issueBody,
      "",
      `Affected packages: ${input.affectedPackages.join(", ")}`,
      `Worktree: ${input.worktreePath}`,
      "",
      "Write a failing test that reproduces the bug. Run it to confirm it fails.",
      "Return the test file path, the describe block name, and the failing output.",
      "",
      "## Required output (JSON)",
      "",
      "```json",
      "{",
      '  "testFilePath": "<path/to/test/file>",',
      '  "describeBlock": "<describe block name>",',
      '  "failingOutput": "<relevant lines from bun test failure output>"',
      "}",
      "```",
      "",
      "Wrap your response in this JSON object exactly. Do not add prose around it.",
    ].join("\n");
  },
});

// FIX — senior-developer implements the minimal code change to fix the bug.
// Shares the bugfixSession with reproduce for full conversation context.
const fixAgent = defineAgent({
  runner: "codex",
  input: z.object({
    issueNumber: z.number().int().positive(),
    testFilePath: z.string(),
    describeBlock: z.string(),
    failingOutput: z.string(),
    worktreePath: z.string(),
  }),
  output: z.object({
    filesChanged: z.array(z.string()),
    summary: z.string(),
  }),
  prompt: (input) => {
    const role = loadRoleSync("engineering-senior-developer");
    return [
      role.body,
      "---",
      `Bugfix issue #${input.issueNumber}`,
      `Failing test: ${input.testFilePath} :: ${input.describeBlock}`,
      `Previous failing output: ${input.failingOutput}`,
      `Worktree: ${input.worktreePath}`,
      "",
      "Fix the bug. Run the previously failing test — it must pass now.",
      "Return files changed + summary.",
      "",
      "## Required output (JSON)",
      "",
      "```json",
      "{",
      '  "filesChanged": ["<path/to/changed/file>"],',
      '  "summary": "<one-line summary of the fix>"',
      "}",
      "```",
      "",
      "Wrap your response in this JSON object exactly. Do not add prose around it.",
    ].join("\n");
  },
});

// TEST — deterministic bun test runner. Same pattern as PR C feature pipeline.
// Spawns `bun test` in the worktree; returns pass/fail + output.
const testFn = defineFunction({
  name: "test",
  input: z.object({
    worktreePath: z.string(),
  }),
  output: z.object({
    passed: z.boolean(),
    output: z.string(),
  }),
  execute: async (input) => {
    try {
      const result = await execa("bun", ["test"], {
        cwd: input.worktreePath,
        timeout: 10 * 60 * 1000, // 10 minutes
        reject: false,
      });
      const output = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      const passed = result.exitCode === 0;
      return { passed, output };
    } catch (err) {
      return {
        passed: false,
        output: (err as Error).message,
      };
    }
  },
});

// VERIFY — reality-checker proves the bug is actually gone.
// Carries over from sub-PR 2 — not modified.
const realityCheckerAgent = defineAgent({
  runner: "codex",
  input: z.object({
    issueNumber: z.number().int().positive(),
    worktreePath: z.string(),
  }),
  output: z.object({
    commandsRun: z.array(
      z.object({
        cmd: z.string(),
        result: z.enum(["PASS", "FAIL", "SKIPPED"]),
      }),
    ),
    regressionProof: z.string(),
    gate: z.enum(["APPROVED", "NEEDS_WORK"]),
  }),
  prompt: (input) => {
    const role = loadRoleSync("testing-reality-checker");
    return [
      role.body,
      "---",
      `Bugfix issue #${input.issueNumber}`,
      `Worktree: ${input.worktreePath}`,
      "",
      "Reproduce the bug on master, then verify the fix on the worktree",
      "branch. Cite the test file + describe block that captures the bug.",
    ].join("\n");
  },
});

// SHIP — deterministic git + gh. Runs only when gate = APPROVED.
// Mirrors docs/publishFn with `fix:` commit/PR title prefix instead of `docs:`.
const shipFn = defineFunction({
  name: "ship",
  input: z.object({
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    worktreePath: z.string(),
    filesChanged: z.array(z.string()),
    summary: z.string(),
    gate: z.enum(["APPROVED", "NEEDS_WORK"]),
  }),
  output: z.object({
    prNumber: z.number().int().positive().nullable(),
    branch: z.string(),
    commit: z.string(),
  }),
  execute: async (input) => {
    if (input.gate !== "APPROVED") {
      throw new Error(`ship blocked: verify gate = ${input.gate}`);
    }

    // Read the branch the worktree is already on (set by createWorktree).
    const { stdout: branchRaw } = await execa(
      "git",
      ["branch", "--show-current"],
      { cwd: input.worktreePath },
    );
    const currentBranch = branchRaw.trim();

    // Stage files. Guard against hallucinated paths: skip files that fail.
    for (const file of input.filesChanged) {
      try {
        await execa("git", ["add", "--", file], { cwd: input.worktreePath });
      } catch (err) {
        console.warn(
          `[bugfix/ship] git add failed for "${file}" — skipping: ${(err as Error).message}`,
        );
      }
    }

    const commitMsg = `fix: #${input.issueNumber} — ${input.summary}\n\nCloses #${input.issueNumber}`;
    await execa("git", ["commit", "-m", commitMsg], {
      cwd: input.worktreePath,
    });

    const { stdout: commitHash } = await execa("git", ["rev-parse", "HEAD"], {
      cwd: input.worktreePath,
    });

    await execa("git", ["push", "-u", "origin", currentBranch], {
      cwd: input.worktreePath,
    });

    const body = `## Summary\n\n${input.summary}\n\nCloses #${input.issueNumber}`;
    const { stdout: prUrl } = await execa(
      "gh",
      [
        "pr",
        "create",
        "--head",
        currentBranch,
        "--title",
        `fix: #${input.issueNumber} — ${input.issueTitle}`,
        "--body",
        body,
      ],
      { cwd: input.worktreePath },
    );

    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? Number(prNumberMatch[1]) : null;

    return { prNumber, branch: currentBranch, commit: commitHash.trim() };
  },
});

export const createBugfixPipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "bugfix-pipeline",
    tasks: {
      // TRIAGE — classify severity + identify affected packages from labels/body.
      triage: {
        fn: triageFn,
        input: () => ({
          issueNumber: input.issue.number,
          labels: input.issue.labels,
          issueBody: input.issue.body,
        }),
      },

      // REPRODUCE — write a failing test that captures the bug.
      // Session: bugfixSession — fix agent will have full reproduce conversation context.
      reproduce: {
        agent: reproduceAgent,
        session: bugfixSession,
        dependsOn: ["triage"] as const,
        input: (ctx: {
          triage: {
            output: {
              severity: string;
              affectedPackages: string[];
            };
          };
        }) => ({
          issueNumber: input.issue.number,
          issueTitle: input.issue.title,
          issueBody: input.issue.body,
          affectedPackages: ctx.triage.output.affectedPackages,
          worktreePath: input.worktreePath,
        }),
      },

      // FIX — implement the minimal code change.
      // Session: bugfixSession (same token as reproduce) — continuation.
      fix: {
        agent: fixAgent,
        session: bugfixSession,
        dependsOn: ["reproduce"] as const,
        input: (ctx: {
          reproduce: {
            output: {
              testFilePath: string;
              describeBlock: string;
              failingOutput: string;
            };
          };
        }) => ({
          issueNumber: input.issue.number,
          testFilePath: ctx.reproduce.output.testFilePath,
          describeBlock: ctx.reproduce.output.describeBlock,
          failingOutput: ctx.reproduce.output.failingOutput,
          worktreePath: input.worktreePath,
        }),
      },

      // TEST — deterministic bun test runner; confirms the failing test passes.
      test: {
        fn: testFn,
        dependsOn: ["fix"] as const,
        input: () => ({
          worktreePath: input.worktreePath,
        }),
      },

      // VERIFY — reality-checker proves the bug is actually gone.
      // Depends on both test (ordering) and fix (needs filesChanged for context,
      // but passes only issueNumber+worktreePath — reality-checker runs git diff itself).
      verify: {
        agent: realityCheckerAgent,
        dependsOn: ["test"] as const,
        input: () => ({
          issueNumber: input.issue.number,
          worktreePath: input.worktreePath,
        }),
      },

      // SHIP — push branch + open PR (gate-gated by verify output).
      ship: {
        fn: shipFn,
        dependsOn: ["verify", "fix"] as const,
        input: (ctx: {
          verify: { output: { gate: "APPROVED" | "NEEDS_WORK" } };
          fix: { output: { filesChanged: string[]; summary: string } };
        }) => ({
          issueNumber: input.issue.number,
          issueTitle: input.issue.title,
          worktreePath: input.worktreePath,
          filesChanged: ctx.fix.output.filesChanged,
          summary: ctx.fix.output.summary,
          gate: ctx.verify.output.gate,
        }),
      },
    },
  }),
);
