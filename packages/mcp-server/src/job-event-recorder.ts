import type { WorkflowEvent } from "@ageflow/core";

export interface ProgressSnapshot {
  readonly lastTaskStart?: { readonly taskName: string; readonly at: number };
  readonly tasksCompleted: number;
  readonly lastBudgetWarning?: {
    readonly spentUsd: number;
    readonly limitUsd: number;
    readonly at: number;
  };
}

/**
 * Per-run progress accumulator. Fed by the executor's event stream via
 * `fire({ onEvent })` inside the job dispatcher.
 *
 * Lifetime: entries are created on the first event for a runId and cleared
 * explicitly via `forget(runId)` when the corresponding RunHandle leaves
 * the RunRegistry (TTL eviction or terminal state + cleanup pass).
 */
export class JobEventRecorder {
  private readonly map = new Map<string, ProgressSnapshotMutable>();

  record(ev: WorkflowEvent): void {
    const snap = this.ensure(ev.runId);
    switch (ev.type) {
      case "task:start":
        snap.lastTaskStart = { taskName: ev.taskName, at: ev.timestamp };
        return;
      case "task:complete":
        snap.tasksCompleted += 1;
        return;
      case "budget:warning":
        snap.lastBudgetWarning = {
          spentUsd: ev.spentUsd,
          limitUsd: ev.limitUsd,
          at: ev.timestamp,
        };
        return;
      default:
        return;
    }
  }

  snapshot(runId: string): ProgressSnapshot | undefined {
    return this.map.get(runId);
  }

  forget(runId: string): void {
    this.map.delete(runId);
  }

  private ensure(runId: string): ProgressSnapshotMutable {
    let s = this.map.get(runId);
    if (!s) {
      s = { tasksCompleted: 0 };
      this.map.set(runId, s);
    }
    return s;
  }
}

interface ProgressSnapshotMutable {
  lastTaskStart?: { taskName: string; at: number };
  tasksCompleted: number;
  lastBudgetWarning?: { spentUsd: number; limitUsd: number; at: number };
}
