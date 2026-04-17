import type { McpConfig } from "./types.js";

export const MCP_SAFE_DEFAULTS = {
  maxCostUsd: 1.0,
  maxDurationSec: 300,
  maxTurns: 20,
} as const;

export interface ResolvedMcpConfig {
  readonly description: string | undefined;
  readonly maxCostUsd: number | null;
  readonly maxDurationSec: number | null;
  readonly maxTurns: number | null;
  readonly inputTask: string | undefined;
  readonly outputTask: string | undefined;
}

/**
 * Resolve a workflow's `mcp` field into a normalized config with defaults applied.
 *
 * - `undefined` → safe defaults
 * - `false` → throws (workflow explicitly unexposable)
 * - `{ limits: "unsafe-unlimited" }` → all three ceilings set to null
 * - `{ maxCostUsd: null, ... }` → null preserved (unlimited for that axis)
 * - partial config → missing fields filled from safe defaults
 */
export function resolveMcpConfig(
  config: McpConfig | false | undefined,
): ResolvedMcpConfig {
  if (config === false) {
    throw new Error(
      "WORKFLOW_NOT_MCP_EXPOSABLE: workflow has `mcp: false` — cannot expose via MCP server",
    );
  }

  const c = config ?? {};
  const isUnlimited = c.limits === "unsafe-unlimited";

  const resolveCeiling = (
    value: number | null | undefined,
    defaultValue: number,
  ): number | null => {
    if (isUnlimited) return null;
    if (value === null) return null;
    if (value === undefined) return defaultValue;
    return value;
  };

  return {
    description: c.description,
    maxCostUsd: resolveCeiling(c.maxCostUsd, MCP_SAFE_DEFAULTS.maxCostUsd),
    maxDurationSec: resolveCeiling(
      c.maxDurationSec,
      MCP_SAFE_DEFAULTS.maxDurationSec,
    ),
    maxTurns: resolveCeiling(c.maxTurns, MCP_SAFE_DEFAULTS.maxTurns),
    inputTask: c.inputTask,
    outputTask: c.outputTask,
  };
}
