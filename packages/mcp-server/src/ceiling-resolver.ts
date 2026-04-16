import type { ResolvedMcpConfig } from "@ageflow/core";
import type { CliCeilings, EffectiveCeilings } from "./types.js";

type WarnFn = (message: string) => void;

/**
 * Compose workflow ceilings with CLI overrides.
 *
 * Rules:
 * - Workflow ceiling is the hard upper bound.
 * - Operator can *lower* via CLI; attempt to raise is clamped with a warning.
 * - `null` = +Infinity (unlimited).
 * - CLI `null` (--no-max-X) removes the operator ceiling; workflow ceiling still applies.
 */
export function composeCeilings(
  workflow: ResolvedMcpConfig,
  cli: CliCeilings,
  warn: WarnFn = () => {},
): EffectiveCeilings {
  return {
    maxCostUsd: resolveOne(
      workflow.maxCostUsd,
      cli.maxCostUsd,
      "maxCostUsd",
      warn,
    ),
    maxDurationSec: resolveOne(
      workflow.maxDurationSec,
      cli.maxDurationSec,
      "maxDurationSec",
      warn,
    ),
    maxTurns: resolveOne(workflow.maxTurns, cli.maxTurns, "maxTurns", warn),
  };
}

function resolveOne(
  workflowValue: number | null,
  cliValue: number | null | undefined,
  fieldName: string,
  warn: WarnFn,
): number | null {
  // CLI not set (undefined) → use workflow value
  if (cliValue === undefined) return workflowValue;

  // CLI explicitly null (--no-max-X) → remove operator ceiling, workflow wins
  if (cliValue === null) {
    if (workflowValue !== null) {
      warn(
        `[mcp] --no-${fieldName} ignored: workflow sets ${fieldName}=${workflowValue} as hard ceiling`,
      );
    }
    return workflowValue;
  }

  // Both numeric → min (with null = +Infinity)
  if (workflowValue === null) return cliValue;
  if (cliValue > workflowValue) {
    warn(
      `[mcp] CLI ${fieldName}=${cliValue} clamped to workflow ceiling ${workflowValue}`,
    );
    return workflowValue;
  }
  return cliValue;
}
