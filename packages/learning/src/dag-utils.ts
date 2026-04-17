/**
 * DAG utility: compute the transitive set of downstream tasks for a given task.
 *
 * "Downstream" means: any task T' where T' has taskName in its transitive
 * dependsOn closure (i.e. T is an ancestor of T' in the dependency graph).
 *
 * @param dagStructure  Map of taskName → direct dependsOn list.
 *                      Matches the `dagStructure` field in ReflectionInput.
 * @param taskName      The task whose descendants we want.
 * @returns             A Set of task names that transitively depend on taskName.
 *                      Never includes taskName itself.
 */
export function computeDownstream(
  dagStructure: Record<string, readonly string[]>,
  taskName: string,
): ReadonlySet<string> {
  const downstream = new Set<string>();

  // BFS/DFS from taskName following the reverse of dependsOn edges.
  // Build a "dependents" map: for each task A, which tasks directly depend on A?
  const dependents = new Map<string, string[]>();
  for (const [name, deps] of Object.entries(dagStructure)) {
    for (const dep of deps) {
      if (!dependents.has(dep)) {
        dependents.set(dep, []);
      }
      dependents.get(dep)?.push(name);
    }
  }

  // BFS from taskName over dependents edges
  const queue: string[] = [...(dependents.get(taskName) ?? [])];
  for (const t of queue) {
    downstream.add(t);
  }

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i] as string;
    for (const next of dependents.get(current) ?? []) {
      if (!downstream.has(next)) {
        downstream.add(next);
        queue.push(next);
      }
    }
  }

  return downstream;
}
