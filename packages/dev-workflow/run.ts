#!/usr/bin/env bun
/**
 * dev-workflow entry point — dogfood ageflow on its own development.
 *
 * Usage:
 *   bun run run.ts <issue-number>
 *   bun run run.ts --dry-run <issue-number>
 *
 * What this does (sub-PR 4b — real CodexRunner):
 *   1. Parses <issue-number> from argv.
 *   2. Loads the GitHub issue via `gh` CLI (real call, no LLM).
 *   3. Determines pipeline type from issue labels.
 *   4. In --dry-run mode: logs the plan and exits without invoking executor.
 *   5. In live mode: walks the DAG via WorkflowExecutor, fires learning
 *      hooks, persists traces to .ageflow/learning.sqlite. Agent tasks use
 *      CodexRunner which spawns real codex CLI subprocesses (incurs LLM cost).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registerRunner } from "@ageflow/core";
import type { WorkflowHooks } from "@ageflow/core";
import { BudgetTracker, WorkflowExecutor } from "@ageflow/executor";
import { CodexRunner } from "@ageflow/runner-codex";
import { determinePipeline, loadIssue } from "./shared/issue-loader.js";
import { initLearning } from "./shared/learning.js";
import type { PipelineType, WorkflowInput } from "./shared/types.js";
import { worktreePath } from "./shared/worktree.js";

import { createBugfixPipeline } from "./pipelines/bugfix.js";
import { createDocsPipeline } from "./pipelines/docs.js";
import { createFeaturePipeline } from "./pipelines/feature.js";
import { createReleasePipeline } from "./pipelines/release.js";

const pipelineFactories = {
  docs: createDocsPipeline,
  feature: createFeaturePipeline,
  bugfix: createBugfixPipeline,
  release: createReleasePipeline,
} as const;

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

  // Build the workflow input (worktree not created yet — stub path).
  const input: WorkflowInput = {
    issue,
    worktreePath: worktreePath(REPO_ROOT, issue.number),
    specPath: resolve(
      REPO_ROOT,
      "docs/superpowers/specs/2026-04-15-agentflow-design.md",
    ),
    dryRun,
  };

  // Log the plan.
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
    console.log("[dev-workflow] DRY-RUN — plan above; executor not invoked.");
    return;
  }

  // Live mode (sub-PR 4b): walks the DAG, fires learning hooks, persists
  // traces. Agent nodes use CodexRunner — real LLM cost incurred.
  const { hooks, store, dbPath } = initLearning({
    repoRoot: REPO_ROOT,
    workflowName: `dev-workflow:${pipelineType}`,
    reflectEvery: 3,
  });
  console.log(`[dev-workflow] learning store: ${dbPath}`);

  // Register real CodexRunner for the "codex" brand used by all pipelines.
  // No "claude" registration — no pipeline uses it; a missing registration
  // yields a clear RunnerNotRegisteredError rather than a silent stub.
  registerRunner("codex", new CodexRunner());

  const factory = pipelineFactories[pipelineType];
  const pipeline = factory(input);
  // Attach hooks via WorkflowDef.hooks field (executor reads from there).
  // Cast hooks to match the specific task-map type of this pipeline.
  // biome-ignore lint/suspicious/noExplicitAny: cross-pipeline hooks cast
  const pipelineWithHooks = { ...pipeline, hooks: hooks as WorkflowHooks<any> };

  const budgetTracker = new BudgetTracker();
  const executor = new WorkflowExecutor(pipelineWithHooks, { budgetTracker });

  try {
    const result = await executor.run(input);
    console.log("[dev-workflow] workflow complete:");
    console.log(
      JSON.stringify(
        {
          workflow: pipelineType,
          outputKeys: Object.keys(result.outputs ?? {}),
          metrics: result.metrics,
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error("[dev-workflow] fatal:", err);
  process.exit(1);
});
