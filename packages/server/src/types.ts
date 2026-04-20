import type {
  CheckpointEvent,
  RunHandle,
  TasksMap,
  WorkflowDef,
  WorkflowEvent,
} from "@ageflow/core";
import type { WorkflowResult } from "@ageflow/executor";
import type { RunStore } from "./run-store.js";

export type { PersistedRunRecord, RunStore } from "./run-store.js";
export type { RunHandle } from "@ageflow/core";
export type { WorkflowResult } from "@ageflow/executor";

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly onCheckpoint?: (ev: CheckpointEvent) => Promise<boolean> | boolean;
}

export interface FireOptions extends RunOptions {
  readonly onEvent?: (ev: WorkflowEvent) => void;
  readonly onError?: (err: Error) => void;
  readonly onComplete?: (result: WorkflowResult<TasksMap>) => void;
}

export interface RunnerConfig {
  /** Terminal-run TTL before GC. Default: 5 min. */
  readonly ttlMs?: number;
  /** Awaiting-checkpoint TTL before auto-reject. Default: 1 hour. */
  readonly checkpointTtlMs?: number;
  /** How often the reaper sweeps. Default: 60 s. */
  readonly reaperIntervalMs?: number;
  /** runId generator. Default: crypto.randomUUID. */
  readonly generateRunId?: () => string;
  /** Optional run snapshot store. Defaults to an in-memory store. */
  readonly store?: RunStore;
}

export interface Runner {
  stream<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: RunOptions,
  ): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void>;

  run<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: RunOptions,
  ): Promise<WorkflowResult<T>>;

  fire<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input?: unknown,
    options?: FireOptions,
  ): RunHandle;

  resume(runId: string, approved: boolean): void;
  cancel(runId: string): void;
  get(runId: string): RunHandle | undefined;
  list(): readonly RunHandle[];
  /** Internal recovery hook used by async job hydration. */
  recover?(workflow: WorkflowDef): void;
  /** Stop the reaper and shut down all registered runners. Process-level teardown. */
  close(): Promise<void>;
}
