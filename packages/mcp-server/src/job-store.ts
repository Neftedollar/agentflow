import type {
  CheckpointEvent,
  RunHandle,
  WorkflowMetrics,
} from "@ageflow/core";
import type { RunStore } from "@ageflow/server";
import type { ProgressSnapshot } from "./job-event-recorder.js";

export interface PersistedJob extends RunHandle {
  readonly pendingCheckpoint?: CheckpointEvent;
  readonly result?: {
    readonly outputs: Record<string, unknown>;
    readonly metrics: WorkflowMetrics;
  };
  readonly error?: { readonly name: string; readonly message: string };
  readonly progress?: ProgressSnapshot;
}

export interface JobStore extends RunStore {
  get(runId: string): PersistedJob | undefined;
  list(): readonly PersistedJob[];
  upsert(job: RunHandle): void;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, PersistedJob>();

  get(runId: string): PersistedJob | undefined {
    const job = this.jobs.get(runId);
    return job ? structuredClone(job) : undefined;
  }

  list(): readonly PersistedJob[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  upsert(job: RunHandle): void {
    this.jobs.set(job.runId, structuredClone(job));
  }

  delete(runId: string): void {
    this.jobs.delete(runId);
  }

  close(): void {
    this.jobs.clear();
  }
}

export function isExpired(
  job: Pick<PersistedJob, "state" | "lastEventAt">,
  now: number,
  ttlMs: number,
  checkpointTtlMs: number,
): boolean {
  if (job.state === "awaiting-checkpoint") {
    return now - job.lastEventAt > checkpointTtlMs;
  }
  if (
    job.state === "done" ||
    job.state === "failed" ||
    job.state === "cancelled"
  ) {
    return now - job.lastEventAt > ttlMs;
  }
  return false;
}

export function toPersistedJob(
  snapshot: Pick<
    RunHandle,
    | "runId"
    | "workflowName"
    | "state"
    | "createdAt"
    | "lastEventAt"
    | "pendingCheckpoint"
    | "result"
    | "error"
  >,
  progress?: ProgressSnapshot,
): PersistedJob {
  return {
    runId: snapshot.runId,
    workflowName: snapshot.workflowName,
    state: snapshot.state,
    createdAt: snapshot.createdAt,
    lastEventAt: snapshot.lastEventAt,
    ...(snapshot.pendingCheckpoint !== undefined
      ? { pendingCheckpoint: snapshot.pendingCheckpoint }
      : {}),
    ...(snapshot.result !== undefined ? { result: snapshot.result } : {}),
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
}
