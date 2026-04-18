#!/usr/bin/env bun
/**
 * dev-workflow entry point — dogfood ageflow on its own development.
 *
 * Usage:
 *   bun run run.ts <issue-number>
 *   bun run run.ts --dry-run <issue-number>
 *
 * What this does (sub-PR 4a — executor wiring):
 *   1. Parses <issue-number> from argv.
 *   2. Loads the GitHub issue via `gh` CLI (real call, no LLM).
 *   3. Determines pipeline type from issue labels.
 *   4. In --dry-run mode: logs the plan and exits without invoking executor.
 *   5. In live mode: walks the DAG via WorkflowExecutor, fires learning
 *      hooks, persists traces to .ageflow/learning.sqlite. Agent tasks use
 *      registered stub runners (no LLM calls) — real runners land in sub-PR 4b.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registerRunner } from "@ageflow/core";
import type {
  Runner,
  RunnerSpawnArgs,
  RunnerSpawnResult,
  WorkflowHooks,
} from "@ageflow/core";
import { BudgetTracker, WorkflowExecutor } from "@ageflow/executor";
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

/**
 * Stub runner — returns a valid empty-ish JSON object for any agent output
 * schema. Used in sub-PR 4a so the executor can walk agent nodes without
 * invoking real LLMs. Replaced by real runners in sub-PR 4b.
 */
function makeStubRunner(brand: string): Runner {
  return {
    async validate() {
      return { ok: true, version: `stub-${brand}` };
    },
    async spawn(_args: RunnerSpawnArgs): Promise<RunnerSpawnResult> {
      // Return an empty JSON object — executor will zod-parse it against the
      // agent's output schema. All agent output schemas use .passthrough() or
      // have optional fields where possible; noop tasks return {}.
      // For agent nodes (architectAgent, codeReviewerAgent, realityCheckerAgent)
      // the schemas require specific fields — return minimal valid payloads.
      const stdout = JSON.stringify({
        plan: "",
        affectedPackages: [],
        versionBumps: [],
        gate: "APPROVED",
        findings: [],
        commandsRun: [],
        regressionProof: "",
      });
      return {
        stdout,
        sessionHandle: `stub-${brand}-${Date.now()}`,
        tokensIn: 0,
        tokensOut: 0,
      };
    },
  };
}

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

  // Live mode (sub-PR 4a): walks the DAG, fires learning hooks, persists
  // traces. Agent nodes use stub runners (no LLM cost). Real runners in 4b.
  const { hooks, store, dbPath } = initLearning({
    repoRoot: REPO_ROOT,
    workflowName: `dev-workflow:${pipelineType}`,
    reflectEvery: 3,
  });
  console.log(`[dev-workflow] learning store: ${dbPath}`);

  // Register stub runners for all runner brands used by the pipelines.
  // Sub-PR 4b replaces these with real ClaudeRunner / CodexRunner instances.
  registerRunner("codex", makeStubRunner("codex"));
  registerRunner("claude", makeStubRunner("claude"));

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
