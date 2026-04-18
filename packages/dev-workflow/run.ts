#!/usr/bin/env bun
/**
 * dev-workflow entry point — dogfood ageflow on its own development.
 *
 * Usage:
 *   bun run run.ts <issue-number>
 *   bun run run.ts --dry-run <issue-number>
 *
 * What this does (sub-PR 1 — scaffold only):
 *   1. Parses <issue-number> from argv.
 *   2. Loads the GitHub issue via `gh` CLI (real call, no LLM).
 *   3. Determines pipeline type from issue labels.
 *   4. Logs the determination and would-be plan.
 *   5. Does NOT invoke the executor (deferred to sub-PR 4).
 *
 * Planned API surface (sub-PR 4):
 *   - initRunners()           — register codex + claude runners
 *   - createWorktree()        — isolate pipeline in sibling directory
 *   - pipelineFactory(input)  — build WorkflowDef from chosen pipeline
 *   - new WorkflowExecutor(pipeline, { budgetTracker })
 *   - executor.stream(input)  — AsyncGenerator<WorkflowEvent, WorkflowResult>
 *   - commentIssue()          — gate-progress markers on the GitHub issue
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { determinePipeline, loadIssue } from "./shared/issue-loader.js";
import type { PipelineType, WorkflowInput } from "./shared/types.js";
import { worktreePath } from "./shared/worktree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

async function main(): Promise<void> {
  // Parse argv: --dry-run flag + issue number.
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const issueNumber = Number(args.find((a) => /^\d+$/.test(a)));

  if (!issueNumber) {
    console.error("Usage: bun run run.ts [--dry-run] <issue-number>");
    process.exit(1);
  }

  console.log(`[dev-workflow] loading issue #${issueNumber}…`);

  const issue = await loadIssue(issueNumber);
  const pipelineType: PipelineType = determinePipeline(issue);

  console.log(`[dev-workflow] issue: "${issue.title}"`);
  console.log(`[dev-workflow] labels: [${issue.labels.join(", ")}]`);
  console.log(`[dev-workflow] pipeline: ${pipelineType}`);

  // Build the would-be input (worktree not created yet — stub path).
  const input: WorkflowInput = {
    issue,
    worktreePath: worktreePath(REPO_ROOT, issue.number),
    specPath: resolve(
      REPO_ROOT,
      "docs/superpowers/specs/2026-04-15-agentflow-design.md",
    ),
    dryRun,
  };

  // Log the plan without invoking the executor.
  // Sub-PR 4 replaces this block with real executor.stream() invocation.
  console.log("[dev-workflow] would-be plan:");
  console.log(
    JSON.stringify(
      {
        pipeline: pipelineType,
        issueNumber: input.issue.number,
        worktreePath: input.worktreePath,
        specPath: input.specPath,
        dryRun: input.dryRun,
      },
      null,
      2,
    ),
  );

  if (dryRun) {
    console.log("[dev-workflow] DRY-RUN complete — no LLM calls made.");
    return;
  }

  // Sub-PR 4: uncomment and implement the executor block below.
  //
  // initRunners();
  // const worktree = await createWorktree(REPO_ROOT, issue);
  // const pipelineFactory = { feature: createFeaturePipeline, ... }[pipelineType];
  // const pipeline = pipelineFactory({ ...input, worktreePath: worktree });
  // const budgetTracker = new BudgetTracker();
  // const executor = new WorkflowExecutor(pipeline, { budgetTracker });
  // const gen = executor.stream(input);
  // let result = await gen.next();
  // while (!result.done) { ... result = await gen.next(); }
  // console.log("[dev-workflow] workflow complete:", result.value.metrics);

  console.log(
    "[dev-workflow] scaffold ready — executor dispatch deferred to sub-PR 4 (see #194).",
  );
}

main().catch((err) => {
  console.error("[dev-workflow] fatal:", err);
  process.exit(1);
});
