import type {
  CheckpointEvent,
  RunHandle,
  RunState,
  WorkflowMetrics,
} from "@ageflow/core";
import { CheckpointTimeoutError } from "./errors.js";

export interface CreateHandleArgs {
  readonly runId: string;
  readonly workflowName: string;
}

export interface PendingCheckpoint {
  readonly event: CheckpointEvent;
  readonly resolve: (approved: boolean) => void;
}

export class InternalRunHandle {
  readonly runId: string;
  readonly workflowName: string;
  readonly createdAt: number;
  readonly abort: AbortController;

  state: RunState = "running";
  lastEventAt: number;
  pendingCheckpoint?: PendingCheckpoint;
  result?: { outputs: Record<string, unknown>; metrics: WorkflowMetrics };
  error?: Error;

  constructor(args: CreateHandleArgs) {
    this.runId = args.runId;
    this.workflowName = args.workflowName;
    this.createdAt = Date.now();
    this.lastEventAt = this.createdAt;
    this.abort = new AbortController();
  }

  touch(): void {
    this.lastEventAt = Date.now();
  }

  markAwaitingCheckpoint(
    event: CheckpointEvent,
    resolve: (approved: boolean) => void,
  ): void {
    this.state = "awaiting-checkpoint";
    this.pendingCheckpoint = { event, resolve };
    this.touch();
  }

  clearCheckpoint(): void {
    this.pendingCheckpoint = undefined;
    this.state = "running";
    this.touch();
  }

  markDone(result: {
    outputs: Record<string, unknown>;
    metrics: WorkflowMetrics;
  }): void {
    this.state = "done";
    this.result = result;
    this.pendingCheckpoint = undefined;
    this.touch();
  }

  markFailed(err: Error): void {
    this.state = "failed";
    this.error = err;
    this.pendingCheckpoint = undefined;
    this.touch();
  }

  markCancelled(): void {
    this.state = "cancelled";
    this.pendingCheckpoint = undefined;
    this.touch();
  }

  snapshot(): RunHandle {
    const snap: RunHandle = {
      runId: this.runId,
      workflowName: this.workflowName,
      state: this.state,
      createdAt: this.createdAt,
      lastEventAt: this.lastEventAt,
    };
    if (this.pendingCheckpoint) {
      return { ...snap, pendingCheckpoint: this.pendingCheckpoint.event };
    }
    if (this.result) return { ...snap, result: this.result };
    if (this.error) {
      return {
        ...snap,
        error: { name: this.error.name, message: this.error.message },
      };
    }
    return snap;
  }

  autoRejectCheckpoint(): void {
    const pc = this.pendingCheckpoint;
    if (!pc) return;
    pc.resolve(false);
    this.markFailed(new CheckpointTimeoutError(pc.event.taskName));
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
