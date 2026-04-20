import type {
  CheckpointEvent,
  RunHandle,
  RunState,
  WorkflowMetrics,
} from "@ageflow/core";
import { CheckpointTimeoutError } from "./errors.js";
import type { PersistedRunRecord } from "./run-store.js";

export interface CreateHandleArgs {
  readonly runId: string;
  readonly workflowName: string;
  readonly input?: unknown;
  readonly snapshot?: PersistedRunRecord;
  readonly persist?: (snapshot: PersistedRunRecord) => void;
}

export interface PendingCheckpoint {
  readonly event: CheckpointEvent;
  readonly resolve: (approved: boolean) => void;
  readonly recoveredFromStore?: boolean;
}

export class InternalRunHandle {
  readonly runId: string;
  readonly workflowName: string;
  readonly createdAt: number;
  readonly abort: AbortController;
  readonly recoveredFromStore: boolean;
  readonly input?: unknown;
  private readonly persist: ((snapshot: PersistedRunRecord) => void) | undefined;

  state: RunState = "running";
  lastEventAt: number;
  pendingCheckpoint?: PendingCheckpoint;
  result?: { outputs: Record<string, unknown>; metrics: WorkflowMetrics };
  error?: Error;

  constructor(args: CreateHandleArgs) {
    this.runId = args.runId;
    this.workflowName = args.workflowName;
    this.recoveredFromStore = args.snapshot !== undefined;
    this.persist = args.persist;
    this.createdAt = args.snapshot?.createdAt ?? Date.now();
    this.lastEventAt = args.snapshot?.lastEventAt ?? this.createdAt;
    this.abort = new AbortController();
    this.input = args.input ?? args.snapshot?.input;
    if (args.snapshot !== undefined) {
      this.state = args.snapshot.state;
      if (args.snapshot.pendingCheckpoint !== undefined) {
        this.pendingCheckpoint = {
          event: args.snapshot.pendingCheckpoint,
          resolve: () => {},
          recoveredFromStore: true,
        };
      }
      if (args.snapshot.result !== undefined) {
        this.result = args.snapshot.result;
      }
      if (args.snapshot.error !== undefined) {
        this.error = new Error(args.snapshot.error.message);
        this.error.name = args.snapshot.error.name;
      }
    }
  }

  touch(): void {
    this.lastEventAt = Date.now();
  }

  private persistSnapshot(): void {
    if (!this.persist) return;
    const snapshot = this.snapshot();
    const persisted: PersistedRunRecord = {
      ...snapshot,
      ...(this.input !== undefined ? { input: this.input } : {}),
    };
    this.persist(persisted);
  }

  markAwaitingCheckpoint(
    event: CheckpointEvent,
    resolve: (approved: boolean) => void,
  ): void {
    this.state = "awaiting-checkpoint";
    this.pendingCheckpoint = { event, resolve };
    this.touch();
    this.persistSnapshot();
  }

  clearCheckpoint(): void {
    // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes requires delete over undefined assignment
    delete this.pendingCheckpoint;
    this.state = "running";
    this.touch();
    this.persistSnapshot();
  }

  markDone(result: {
    outputs: Record<string, unknown>;
    metrics: WorkflowMetrics;
  }): void {
    this.state = "done";
    this.result = result;
    // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes requires delete over undefined assignment
    delete this.pendingCheckpoint;
    this.touch();
    this.persistSnapshot();
  }

  markFailed(err: Error): void {
    this.state = "failed";
    this.error = err;
    // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes requires delete over undefined assignment
    delete this.pendingCheckpoint;
    this.touch();
    this.persistSnapshot();
  }

  markCancelled(): void {
    this.state = "cancelled";
    // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes requires delete over undefined assignment
    delete this.pendingCheckpoint;
    this.touch();
    this.persistSnapshot();
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

  persistedSnapshot(): PersistedRunRecord {
    return {
      ...this.snapshot(),
      ...(this.input !== undefined ? { input: this.input } : {}),
    };
  }

  autoRejectCheckpoint(): void {
    const pc = this.pendingCheckpoint;
    if (!pc) return;
    if (pc.recoveredFromStore) {
      this.markFailed(new CheckpointTimeoutError(pc.event.taskName));
      return;
    }
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
