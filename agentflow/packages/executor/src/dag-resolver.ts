import type { TasksMap } from "@agentflow/core";
import { CyclicDependencyError } from "./errors.js";

/**
 * Topological sort using Kahn's algorithm.
 * Returns tasks grouped by level — all tasks in the same sub-array have their
 * dependencies satisfied by previous levels and CAN run in parallel.
 * Throws CyclicDependencyError if a cycle is detected.
 *
 * LoopDef tasks are treated as leaf nodes (no traversal into inner tasks).
 */
export function topologicalSort(tasks: TasksMap): string[][] {
  const taskNames = Object.keys(tasks);

  if (taskNames.length === 0) {
    return [];
  }

  // Build in-degree map and adjacency list
  const inDegree = new Map<string, number>();
  // dependents[A] = list of tasks that depend on A
  const dependents = new Map<string, string[]>();

  for (const name of taskNames) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  for (const name of taskNames) {
    const task = tasks[name];
    const deps = task?.dependsOn ?? [];
    for (const dep of deps) {
      // Only count dependencies that are within this tasks map
      if (!inDegree.has(dep)) {
        // External dependency — skip (not in this DAG)
        continue;
      }
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      dependents.get(dep)?.push(name);
    }
  }

  const batches: string[][] = [];
  // Start with all tasks that have no dependencies
  let currentQueue = taskNames.filter((n) => (inDegree.get(n) ?? 0) === 0);

  while (currentQueue.length > 0) {
    batches.push([...currentQueue]);
    const nextQueue: string[] = [];

    for (const name of currentQueue) {
      for (const dependent of dependents.get(name) ?? []) {
        const newDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextQueue.push(dependent);
        }
      }
    }

    currentQueue = nextQueue;
  }

  // If any task still has in-degree > 0, there's a cycle
  const remaining = taskNames.filter((n) => (inDegree.get(n) ?? 0) > 0);
  if (remaining.length > 0) {
    // Try to construct cycle path for error message
    const cycle = findCycle(remaining, tasks);
    throw new CyclicDependencyError(cycle);
  }

  return batches;
}

/**
 * Returns tasks whose all dependsOn are in the completedSet.
 * Used by the executor to find the next batch to run.
 */
export function getReadyTasks(completed: ReadonlySet<string>, tasks: TasksMap): string[] {
  const ready: string[] = [];

  for (const [name, task] of Object.entries(tasks)) {
    if (completed.has(name)) {
      continue;
    }
    const deps = task?.dependsOn ?? [];
    const allDepsComplete = deps.every((dep) => completed.has(dep));
    if (allDepsComplete) {
      ready.push(name);
    }
  }

  return ready;
}

/**
 * Attempt to find a cycle path among the remaining nodes with in-degree > 0.
 * Uses DFS to find a cycle in the subgraph of remaining nodes.
 */
function findCycle(remaining: string[], tasks: TasksMap): string[] {
  const remainingSet = new Set(remaining);

  // DFS-based cycle detection
  const visited = new Set<string>();
  const path: string[] = [];
  const pathSet = new Set<string>();

  function dfs(node: string): string[] | null {
    if (pathSet.has(node)) {
      // Found cycle — extract it
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) {
      return null;
    }

    visited.add(node);
    path.push(node);
    pathSet.add(node);

    const task = tasks[node];
    const deps = task?.dependsOn ?? [];
    for (const dep of deps) {
      if (remainingSet.has(dep)) {
        const cycle = dfs(dep);
        if (cycle !== null) {
          return cycle;
        }
      }
    }

    path.pop();
    pathSet.delete(node);
    return null;
  }

  for (const node of remaining) {
    if (!visited.has(node)) {
      const cycle = dfs(node);
      if (cycle !== null) {
        return cycle;
      }
    }
  }

  // Fallback: just return the remaining nodes
  return remaining;
}
