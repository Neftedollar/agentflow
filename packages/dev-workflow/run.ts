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
import type { TasksMap, WorkflowEvent, WorkflowHooks } from "@ageflow/core";
import { BudgetTracker, WorkflowExecutor } from "@ageflow/executor";
import { CodexRunner } from "@ageflow/runner-codex";
import { determinePipeline, loadIssue } from "./shared/issue-loader.js";
import { initLearning } from "./shared/learning.js";
import type { PipelineType, WorkflowInput } from "./shared/types.js";
import {
  createWorktree,
  removeWorktree,
  worktreePath,
} from "./shared/worktree.js";

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

function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderEvent(
  ev: WorkflowEvent,
  budgetCapUsd: number | undefined,
  state: {
    readonly starts: Map<string, number>;
    spentUsd: number;
    warned80: boolean;
  },
): void {
  if (ev.type === "task:start") {
    state.starts.set(ev.taskName, ev.timestamp);
    console.log(`[progress] ▶ ${ev.taskName} started`);
    return;
  }

  if (ev.type === "task:complete") {
    const startedAt = state.starts.get(ev.taskName);
    const durationMs =
      startedAt !== undefined ? ev.timestamp - startedAt : ev.metrics.latencyMs;
    state.starts.delete(ev.taskName);

    state.spentUsd += ev.metrics.estimatedCost;
    console.log(
      `[progress] ✓ ${ev.taskName} completed in ${formatMs(durationMs)} | +${formatUsd(ev.metrics.estimatedCost)} (spent ${formatUsd(state.spentUsd)})`,
    );

    if (budgetCapUsd !== undefined) {
      const pct = (state.spentUsd / budgetCapUsd) * 100;
      console.log(
        `[budget] ${formatUsd(state.spentUsd)} / ${formatUsd(budgetCapUsd)} (${pct.toFixed(1)}%)`,
      );
      if (!state.warned80 && pct >= 80) {
        state.warned80 = true;
        console.warn(
          `[budget] warning: reached ${pct.toFixed(1)}% of cap ${formatUsd(budgetCapUsd)}`,
        );
      }
    } else {
      console.log(`[budget] spent ${formatUsd(state.spentUsd)} (no cap)`);
    }
    return;
  }

  if (ev.type === "task:error") {
    const startedAt = state.starts.get(ev.taskName);
    const durationMs = startedAt !== undefined ? ev.timestamp - startedAt : 0;
    state.starts.delete(ev.taskName);
    const durationSuffix =
      durationMs > 0 ? ` after ${formatMs(durationMs)}` : "";
    console.error(
      `[progress] ✗ ${ev.taskName} failed${durationSuffix}: ${ev.error.message}`,
    );
    return;
  }

  if (ev.type === "budget:warning") {
    console.warn(
      `[budget] executor warning: spent ${formatUsd(ev.spentUsd)} > limit ${formatUsd(ev.limitUsd)}`,
    );
  }
}

export async function runWithProgress<T extends TasksMap>(
  executor: WorkflowExecutor<T>,
  input: WorkflowInput,
  budgetCapUsd?: number,
): Promise<{ outputs?: { [K in keyof T]?: unknown }; metrics?: unknown }> {
  const state = {
    starts: new Map<string, number>(),
    spentUsd: 0,
    warned80: false,
  };
  const stream = executor.stream(input);

  while (true) {
    const next = await stream.next();
    if (next.done) {
      return {
        outputs: next.value.outputs,
        metrics: next.value.metrics,
      };
    }
    renderEvent(next.value, budgetCapUsd, state);
  }
}

async function main(): Promise<void> {
  // Parse argv: --dry-run flag + issue number + optional --budget=<N>.
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const issueNumber = Number(args.find((a) => /^\d+$/.test(a)));
  const budgetArg = args.find((a) => a.startsWith("--budget="));
  let maxUsd = 5;
  if (budgetArg) {
    const raw = budgetArg.split("=")[1];
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(
        `[dev-workflow] invalid --budget value: "${raw}" — must be a positive number`,
      );
      process.exit(1);
    }
    maxUsd = parsed;
  }

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

  // Build the workflow input with stub path for dry-run plan logging.
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
        budgetUsd: maxUsd,
      },
      null,
      2,
    ),
  );

  if (dryRun) {
    console.log("[dev-workflow] DRY-RUN — plan above; executor not invoked.");
    return;
  }

  // Outer try/finally: createWorktree is inside so any failure in
  // initLearning / registerRunner / pipeline construction / executor still
  // triggers removeWorktree, preventing stale worktrees on error.
  let worktree: string | undefined;
  try {
    worktree = await createWorktree(REPO_ROOT, issue);
    console.log(`[dev-workflow] worktree created: ${worktree}`);

    const updatedInput: WorkflowInput = { ...input, worktreePath: worktree };

    // Inner try/finally: ensures store.close() runs whenever initLearning
    // succeeds, regardless of executor success or failure.
    // Live mode (sub-PR 4b): walks the DAG, fires learning hooks, persists
    // traces. Agent nodes use CodexRunner — real LLM cost incurred.
    const { hooks, store, dbPath } = initLearning({
      repoRoot: REPO_ROOT,
      workflowName: `dev-workflow:${pipelineType}`,
      reflectEvery: 3,
    });
    console.log(`[dev-workflow] learning store: ${dbPath}`);

    try {
      // Register real CodexRunner for the "codex" brand used by all pipelines.
      // No "claude" registration — no pipeline uses it; a missing registration
      // yields a clear RunnerNotRegisteredError rather than a silent stub.
      registerRunner("codex", new CodexRunner());

      const factory = pipelineFactories[pipelineType];
      const pipeline = factory(updatedInput);
      // Attach hooks and budget cap via WorkflowDef fields (executor reads from there).
      // BudgetConfig: maxCost = USD cap, onExceed = "halt" aborts on overrun.
      // Cast hooks to match the specific task-map type of this pipeline.
      const pipelineWithHooks = {
        ...pipeline,
        // biome-ignore lint/suspicious/noExplicitAny: cross-pipeline hooks cast — each pipeline has its own TasksMap
        hooks: hooks as WorkflowHooks<any>,
        budget: { maxCost: maxUsd, onExceed: "halt" as const },
      };

      const budgetTracker = new BudgetTracker();
      const executor = new WorkflowExecutor(pipelineWithHooks, {
        budgetTracker,
      });

      const result = await runWithProgress(executor, updatedInput, maxUsd);
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
  } finally {
    if (worktree !== undefined) {
      await removeWorktree(REPO_ROOT, issue.number).catch((err: Error) => {
        console.warn(`[dev-workflow] worktree cleanup failed: ${err.message}`);
      });
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[dev-workflow] fatal:", err);
    process.exit(1);
  });
}
