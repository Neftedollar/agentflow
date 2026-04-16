import type { TasksMap } from "@ageflow/core";
import { ErrorCode, McpServerError } from "./errors.js";

export interface BoundaryTasks {
  readonly inputTask: string;
  readonly outputTask: string;
}

/**
 * Identify the task whose input defines the tool's inputSchema (the DAG root)
 * and the task whose output defines the tool's outputSchema (the DAG leaf).
 *
 * If explicit inputTask/outputTask are provided, validate and use them.
 * Otherwise find the unique root/leaf; throw if ambiguous.
 */
export function findBoundaryTasks(
  tasks: TasksMap,
  inputTaskOverride: string | undefined,
  outputTaskOverride: string | undefined,
): BoundaryTasks {
  const taskNames = Object.keys(tasks);
  const allDeps = new Set<string>();

  for (const [, t] of Object.entries(tasks)) {
    const deps = (t as { dependsOn?: readonly string[] }).dependsOn ?? [];
    for (const d of deps) allDeps.add(d);
  }

  // Roots: tasks with no dependsOn
  const roots = taskNames.filter((n) => {
    const deps =
      (tasks[n] as { dependsOn?: readonly string[] }).dependsOn ?? [];
    return deps.length === 0;
  });

  // Leaves: tasks not in any dependsOn set
  const leaves = taskNames.filter((n) => !allDeps.has(n));

  // Resolve input task
  let inputTask: string;
  if (inputTaskOverride !== undefined) {
    if (!taskNames.includes(inputTaskOverride)) {
      throw new McpServerError(
        ErrorCode.DAG_INVALID,
        `inputTask "${inputTaskOverride}" not found in workflow tasks`,
        { inputTask: inputTaskOverride },
      );
    }
    inputTask = inputTaskOverride;
  } else if (roots.length === 0) {
    throw new McpServerError(
      ErrorCode.DAG_INVALID,
      "workflow has no root task (cyclic?)",
    );
  } else if (roots.length > 1) {
    throw new McpServerError(
      ErrorCode.DAG_INVALID,
      `workflow has multiple root tasks (${roots.join(", ")}); set workflow.mcp.inputTask to disambiguate`,
      { roots },
    );
  } else {
    inputTask = roots[0] as string;
  }

  // Resolve output task
  let outputTask: string;
  if (outputTaskOverride !== undefined) {
    if (!taskNames.includes(outputTaskOverride)) {
      throw new McpServerError(
        ErrorCode.DAG_INVALID,
        `outputTask "${outputTaskOverride}" not found in workflow tasks`,
        { outputTask: outputTaskOverride },
      );
    }
    outputTask = outputTaskOverride;
  } else if (leaves.length === 0) {
    throw new McpServerError(
      ErrorCode.DAG_INVALID,
      "workflow has no leaf task (cyclic?)",
    );
  } else if (leaves.length > 1) {
    throw new McpServerError(
      ErrorCode.DAG_INVALID,
      `workflow has multiple leaf tasks (${leaves.join(", ")}); set workflow.mcp.outputTask to disambiguate`,
      { leaves },
    );
  } else {
    outputTask = leaves[0] as string;
  }

  return { inputTask, outputTask };
}
