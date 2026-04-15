import type { TasksMap } from "@ageflow/core";
import { SessionCycleError, UnresolvedSessionRefError } from "./errors.js";

/**
 * Manages session handle lifecycle for a single workflow run.
 *
 * - Resolves ShareSessionRef chains transitively to a canonical SessionToken name
 * - Stores and retrieves sessionHandles by canonical token name
 * - Detects cycles in shareSessionWith chains at construction time
 */
export class SessionManager {
  // canonical token name → current session handle
  private readonly handles = new Map<string, string>();
  // task name → canonical token name (resolved at construction)
  private readonly taskTokens = new Map<string, string>();

  constructor(tasks: TasksMap) {
    this._resolveAll(tasks);
  }

  /** Returns canonical token name for a task, or undefined if no session. */
  canonicalToken(taskName: string): string | undefined {
    return this.taskTokens.get(taskName);
  }

  /** Returns current session handle for a task's session, or undefined if not yet set. */
  getHandle(taskName: string): string | undefined {
    const token = this.taskTokens.get(taskName);
    if (token === undefined) return undefined;
    return this.handles.get(token);
  }

  /** Store a session handle after a task completes. */
  setHandle(taskName: string, handle: string): void {
    const token = this.taskTokens.get(taskName);
    if (token !== undefined && handle !== "") {
      this.handles.set(token, handle);
    }
  }

  /**
   * Store a handle keyed to a specific canonical token.
   * Used by LoopExecutor for per-slot persistence across iterations.
   */
  setHandleByToken(tokenName: string, handle: string): void {
    if (handle !== "") {
      this.handles.set(tokenName, handle);
    }
  }

  getHandleByToken(tokenName: string): string | undefined {
    return this.handles.get(tokenName);
  }

  // ─── Private resolution ──────────────────────────────────────────────────────

  private _resolveAll(tasks: TasksMap): void {
    for (const taskName of Object.keys(tasks)) {
      // Only resolve if we haven't already (shared refs may cause multiple lookups)
      if (!this.taskTokens.has(taskName)) {
        const canonical = this._resolveOne(taskName, tasks, new Set());
        if (canonical !== undefined) {
          this.taskTokens.set(taskName, canonical);
        }
      }
    }
  }

  /**
   * Resolve the canonical token name for a task's session.
   * Returns undefined if the task has no session.
   * Throws SessionCycleError on circular refs.
   * Throws UnresolvedSessionRefError if a ShareSessionRef points to a task with no session.
   */
  private _resolveOne(
    taskName: string,
    tasks: TasksMap,
    visited: Set<string>,
  ): string | undefined {
    const taskDef = tasks[taskName];
    if (taskDef === undefined) return undefined;

    // LoopDef has no session field
    if ("kind" in taskDef) return undefined;

    const session = taskDef.session;
    if (session === undefined) return undefined;

    if (session.kind === "token") {
      // SessionToken — canonical name is token.name
      return session.name;
    }

    // ShareSessionRef — follow the chain
    const targetTaskName = session.taskName;

    if (visited.has(taskName)) {
      // We've seen this task during traversal — cycle detected
      const cycle = [...visited, taskName];
      throw new SessionCycleError(cycle);
    }

    visited.add(taskName);

    // Check if we already resolved the target
    const cached = this.taskTokens.get(targetTaskName);
    if (cached !== undefined) {
      return cached;
    }

    const targetDef = tasks[targetTaskName];
    if (
      targetDef === undefined ||
      "kind" in targetDef ||
      targetDef.session === undefined
    ) {
      throw new UnresolvedSessionRefError(taskName, targetTaskName);
    }

    const resolved = this._resolveOne(targetTaskName, tasks, visited);
    if (resolved === undefined) {
      throw new UnresolvedSessionRefError(taskName, targetTaskName);
    }

    // Cache resolved target for future lookups
    this.taskTokens.set(targetTaskName, resolved);
    return resolved;
  }
}
