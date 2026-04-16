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

export type HitlStrategy = "elicit" | "auto" | "fail";
