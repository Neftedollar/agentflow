import { spawnSync } from "node:child_process";
import type { TasksMap, WorkflowDef } from "@ageflow/core";
import { validateStaticIdentifier } from "@ageflow/core";
import { topologicalSort } from "./dag-resolver.js";
import {
  CyclicDependencyError,
  SessionCycleError,
  UnresolvedDependencyError,
  UnresolvedSessionRefError,
} from "./errors.js";
import { SessionManager } from "./session-manager.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreflightResult {
  errors: string[];
  warnings: string[];
}

/** Injectable which/spawnSync for testing */
export type WhichFn = (runnerName: string) => boolean;

const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;

// ─── Default which implementation ─────────────────────────────────────────────

function defaultWhich(runnerName: string): boolean {
  const result = spawnSync("which", [runnerName], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

// ─── Runner install hints ──────────────────────────────────────────────────────

const RUNNER_INSTALL_HINTS: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
};

function installHint(runnerName: string): string {
  const hint = RUNNER_INSTALL_HINTS[runnerName];
  return hint !== undefined ? ` Install with: ${hint}` : "";
}

// ─── Validation steps ─────────────────────────────────────────────────────────

function validateRunners(
  tasks: TasksMap,
  errors: string[],
  whichFn: WhichFn,
): void {
  const seen = new Set<string>();

  for (const task of Object.values(tasks)) {
    if (task === undefined || "kind" in task) {
      // LoopDef — recurse into inner tasks
      if (task !== undefined && "kind" in task && task.kind === "loop") {
        validateRunners(task.tasks as TasksMap, errors, whichFn);
      }
      continue;
    }

    const runnerName = task.agent.runner;
    if (seen.has(runnerName)) {
      continue;
    }
    seen.add(runnerName);

    if (!whichFn(runnerName)) {
      errors.push(
        `Runner '${runnerName}' not found on PATH.${installHint(runnerName)}`,
      );
    }
  }
}

function validateDAG(tasks: TasksMap, errors: string[]): void {
  try {
    topologicalSort(tasks);
  } catch (err) {
    if (err instanceof CyclicDependencyError) {
      errors.push(`DAG cycle detected: ${err.cycle.join(" → ")}`);
    } else if (err instanceof UnresolvedDependencyError) {
      errors.push(
        `DAG error: Task "${err.taskName}" depends on "${err.unresolvedDep}" which is not defined in this workflow`,
      );
    } else {
      throw err;
    }
  }

  // Recurse into loop inner tasks so inner cycles/unresolved deps surface at preflight
  for (const task of Object.values(tasks)) {
    if (
      task !== undefined &&
      typeof task === "object" &&
      "kind" in task &&
      task.kind === "loop"
    ) {
      validateDAG((task as { tasks: TasksMap }).tasks, errors);
    }
  }
}

function validateSessionRefs(tasks: TasksMap, errors: string[]): void {
  try {
    new SessionManager(tasks);
  } catch (err) {
    if (err instanceof SessionCycleError) {
      errors.push(`Session reference cycle detected: ${err.cycle.join(" → ")}`);
    } else if (err instanceof UnresolvedSessionRefError) {
      errors.push(
        `Session ref error: Task "${err.taskName}" uses shareSessionWith("${err.targetTask}") but "${err.targetTask}" has no session`,
      );
    } else {
      throw err;
    }
  }
}

function validateStaticArgs(tasks: TasksMap, errors: string[]): void {
  for (const [taskName, task] of Object.entries(tasks)) {
    if (task === undefined || "kind" in task) {
      // LoopDef — recurse
      if (task !== undefined && "kind" in task && task.kind === "loop") {
        validateStaticArgs(task.tasks as TasksMap, errors);
      }
      continue;
    }

    const agent = task.agent;

    // Validate runner identifier
    try {
      validateStaticIdentifier(agent.runner, "runner");
    } catch {
      errors.push(
        `Task "${taskName}": runner "${agent.runner}" is not a valid static identifier`,
      );
    }

    // Validate model identifier
    if (agent.model !== undefined) {
      try {
        validateStaticIdentifier(agent.model, "model");
      } catch {
        errors.push(
          `Task "${taskName}": model "${agent.model}" is not a valid static identifier`,
        );
      }
    }

    // Validate MCP server names
    for (const mcp of agent.mcps ?? []) {
      try {
        validateStaticIdentifier(mcp.server, "mcp.server");
      } catch {
        errors.push(
          `Task "${taskName}": mcp server "${mcp.server}" is not a valid static identifier`,
        );
      }
    }

    // Validate env var names
    if (agent.env?.pass !== undefined) {
      for (const varName of agent.env.pass) {
        if (!ENV_VAR_RE.test(varName)) {
          errors.push(
            `Task "${taskName}": env var name "${varName}" is not a valid env var identifier (must match /^[A-Z_][A-Z0-9_]*$/)`,
          );
        }
      }
    }
  }
}

function validateEnvVars(tasks: TasksMap, warnings: string[]): void {
  for (const [taskName, task] of Object.entries(tasks)) {
    if (task === undefined || "kind" in task) {
      if (task !== undefined && "kind" in task && task.kind === "loop") {
        validateEnvVars(task.tasks as TasksMap, warnings);
      }
      continue;
    }

    const agent = task.agent;
    if (agent.env?.pass === undefined) {
      continue;
    }

    for (const varName of agent.env.pass) {
      if (process.env[varName] === undefined) {
        warnings.push(`Task '${taskName}': env var ${varName} is not set`);
      }
    }
  }
}

function validateCrossProviderSessions(
  tasks: TasksMap,
  warnings: string[],
): void {
  // Build map: canonical token name → set of runner names that use it
  const tokenRunners = new Map<string, Set<string>>();

  // First, build a SessionManager to resolve tokens
  let sessionManager: SessionManager;
  try {
    sessionManager = new SessionManager(tasks);
  } catch {
    // Already caught in validateSessionRefs — skip here
    return;
  }

  for (const [taskName, task] of Object.entries(tasks)) {
    if (task === undefined || "kind" in task) {
      continue;
    }

    const token = sessionManager.canonicalToken(taskName);
    if (token === undefined) {
      continue;
    }

    const runnerName = task.agent.runner;
    const runners = tokenRunners.get(token) ?? new Set<string>();
    runners.add(runnerName);
    tokenRunners.set(token, runners);
  }

  for (const [tokenName, runners] of tokenRunners) {
    if (runners.size > 1) {
      const runnerList = [...runners].sort().join(", ");
      warnings.push(
        `Session '${tokenName}' is shared between different runners (${runnerList}) — context will not carry over`,
      );
    }
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runPreflight(
  workflow: WorkflowDef<TasksMap>,
  options?: { whichFn?: WhichFn },
): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const whichFn = options?.whichFn ?? defaultWhich;
  const tasks = workflow.tasks;

  // 1. Validate runner binaries are present on PATH
  validateRunners(tasks, errors, whichFn);

  // 2. Validate DAG topology (cycle + unresolved deps)
  validateDAG(tasks, errors);

  // 3. Validate session refs (cycle + unresolved)
  validateSessionRefs(tasks, errors);

  // 4. Validate static args (runner/model/mcp identifiers + env var names)
  validateStaticArgs(tasks, errors);

  // 5. Warn about missing env vars
  validateEnvVars(tasks, warnings);

  // 6. Warn about cross-provider session sharing
  validateCrossProviderSessions(tasks, warnings);

  return { errors, warnings };
}
