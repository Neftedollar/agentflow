// Bootstraps the @ageflow/learning observation layer for dev-workflow runs.
// Persists traces + skills to .ageflow/learning.sqlite at the repo root so
// every run accumulates evidence reflection can mine.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkflowHooks } from "@ageflow/core";
import { createLearningHooks } from "@ageflow/learning";
import { SqliteLearningStore } from "@ageflow/learning-sqlite";

export interface InitLearningOptions {
  /** Repo root — `.ageflow/learning.sqlite` is resolved relative to it. */
  readonly repoRoot: string;
  /** Workflow name surfaced in trace records (e.g. "dev-workflow:feature"). */
  readonly workflowName: string;
  /** Reflection cadence — every N completed runs runReflection fires. Default 3. */
  readonly reflectEvery?: number;
  /** Optional DAG structure forwarded to runReflection. Sub-PR 4 will populate. */
  readonly dagStructure?: Record<string, readonly string[]>;
}

export interface InitLearningResult {
  readonly hooks: WorkflowHooks;
  readonly store: SqliteLearningStore;
  readonly dbPath: string;
}

export function initLearning(opts: InitLearningOptions): InitLearningResult {
  const dbPath = join(opts.repoRoot, ".ageflow", "learning.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new SqliteLearningStore(dbPath);
  const hooks = createLearningHooks({
    skillStore: store,
    traceStore: store,
    workflowName: opts.workflowName,
    config: { reflectEvery: opts.reflectEvery ?? 3 },
    ...(opts.dagStructure ? { dagStructure: opts.dagStructure } : {}),
  });
  return { hooks, store, dbPath };
}
