export interface CliCeilings {
  readonly maxCostUsd?: number | null; // null = --no-max-cost flag
  readonly maxDurationSec?: number | null;
  readonly maxTurns?: number | null;
}

export interface EffectiveCeilings {
  readonly maxCostUsd: number | null;
  readonly maxDurationSec: number | null;
  readonly maxTurns: number | null;
}

export interface WorkflowConcurrencyConfig {
  readonly maxConcurrentStarts?: number | null;
  readonly maxConcurrentJobs?: number | null;
  readonly maxConcurrentJobsPerWorkflow?: number | null;
}

export interface ConcurrencyConfig extends WorkflowConcurrencyConfig {
  readonly perWorkflow?: Readonly<Record<string, number | null>>;
  readonly workflows?: Readonly<Record<string, WorkflowConcurrencyConfig>>;
}

export interface ResolvedConcurrencyConfig {
  readonly maxConcurrentStarts: number | null;
  readonly maxConcurrentJobs: number | null;
  readonly workflows: Readonly<Record<string, WorkflowConcurrencyConfig>>;
}

export type HitlStrategy = "elicit" | "auto" | "fail";
