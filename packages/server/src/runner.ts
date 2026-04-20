import type {
  CheckpointEvent,
  RunHandle,
  TasksMap,
  WorkflowDef,
  WorkflowEvent,
} from "@ageflow/core";
import { shutdownAllRunners } from "@ageflow/core";
import { WorkflowExecutor, type WorkflowResult } from "@ageflow/executor";
import { InvalidRunStateError, RunNotFoundError } from "./errors.js";
import { createDeferred, type InternalRunHandle } from "./run-handle.js";
import { RunRegistry } from "./run-registry.js";
import { InMemoryRunStore } from "./run-store.js";
import type { FireOptions, RunOptions, Runner, RunnerConfig } from "./types.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_CHECKPOINT_TTL_MS = 60 * 60_000;
const DEFAULT_REAPER_INTERVAL_MS = 60_000;

export function createRunner(config: RunnerConfig = {}): Runner {
  const store = config.store ?? new InMemoryRunStore();
  const registry = new RunRegistry({
    ttlMs: config.ttlMs ?? DEFAULT_TTL_MS,
    checkpointTtlMs: config.checkpointTtlMs ?? DEFAULT_CHECKPOINT_TTL_MS,
    reaperIntervalMs: config.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS,
    store,
  });
  const generateRunId = config.generateRunId ?? (() => crypto.randomUUID());
  const replayedRunIds = new Set<string>();

  async function* streamImpl<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    input: unknown,
    options: RunOptions | undefined,
    preAllocatedRunId?: string,
    existingHandle?: InternalRunHandle,
  ): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void> {
    const runId = preAllocatedRunId ?? generateRunId();
    const handle =
      existingHandle ?? registry.create({ runId, workflowName: workflow.name, input });

    // Combine caller signal + internal abort.
    if (options?.signal) {
      options.signal.addEventListener("abort", () => handle.abort.abort(), {
        once: true,
      });
    }

    // Build the checkpoint resolver used by the executor:
    //   - If caller provided onCheckpoint, use it directly.
    //   - Otherwise, mark the handle awaiting and return a deferred that
    //     `resume()` resolves.
    const onCheckpoint = async (ev: CheckpointEvent): Promise<boolean> => {
      handle.touch();
      if (options?.onCheckpoint) {
        return await options.onCheckpoint(ev);
      }
      const deferred = createDeferred<boolean>();
      handle.markAwaitingCheckpoint(ev, deferred.resolve);
      const approved = await deferred.promise;
      handle.clearCheckpoint();
      return approved;
    };

    const executor = new WorkflowExecutor(workflow);
    // Pull each event, update registry, yield to caller.
    let result: WorkflowResult<T> | undefined;
    try {
      const inner = executor.stream(input, {
        signal: handle.abort.signal,
        onCheckpoint,
      });
      let step: IteratorResult<WorkflowEvent, WorkflowResult<T>>;
      do {
        step = await inner.next();
        if (!step.done) {
          // Overwrite runId on events — executor generates its own; server's wins
          // so caller sees a single consistent id.
          const ev = { ...step.value, runId } as WorkflowEvent;
          handle.touch();
          yield ev;
        } else {
          result = step.value;
        }
      } while (!step.done);

      if (handle.abort.signal.aborted) {
        handle.markCancelled();
      } else if (result) {
        handle.markDone({
          outputs: result.outputs as Record<string, unknown>,
          metrics: result.metrics,
        });
      }
      return result as WorkflowResult<T>;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (handle.abort.signal.aborted) {
        handle.markCancelled();
      } else {
        handle.markFailed(e);
      }
      throw e;
    }
  }

  return {
    stream<T extends TasksMap>(
      workflow: WorkflowDef<T>,
      input?: unknown,
      options?: RunOptions,
    ): AsyncGenerator<WorkflowEvent, WorkflowResult<T>, void> {
      return streamImpl(workflow, input, options);
    },

    async run<T extends TasksMap>(
      workflow: WorkflowDef<T>,
      input?: unknown,
      options?: RunOptions,
    ): Promise<WorkflowResult<T>> {
      // run() uses least-privilege: auto-reject checkpoints unless caller
      // provides an explicit onCheckpoint resolver.
      const runOptions: RunOptions = {
        ...options,
        onCheckpoint: options?.onCheckpoint ?? (() => false),
      };
      const gen = streamImpl(workflow, input, runOptions);
      let step: IteratorResult<WorkflowEvent, WorkflowResult<T>>;
      do {
        step = await gen.next();
      } while (!step.done);
      return step.value;
    },

    fire<T extends TasksMap>(
      workflow: WorkflowDef<T>,
      input?: unknown,
      options?: FireOptions,
    ): RunHandle {
      // Pre-allocate a runId so we can return a handle synchronously AND ensure
      // streamImpl registers the run under the same id.
      const runId = generateRunId();
      const gen = streamImpl(workflow, input, options, runId);
      (async () => {
        try {
          let step: IteratorResult<WorkflowEvent, WorkflowResult<TasksMap>>;
          do {
            step = await (
              gen as AsyncGenerator<
                WorkflowEvent,
                WorkflowResult<TasksMap>,
                void
              >
            ).next();
            if (!step.done) {
              try {
                options?.onEvent?.(step.value);
              } catch {
                // onEvent exceptions must not exit the drain loop — the run
                // must still reach a terminal state so the registry TTL fires.
              }
            }
          } while (!step.done);
          options?.onComplete?.(step.value);
        } catch (err) {
          options?.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      })();
      // Return a synchronous snapshot — streamImpl hasn't run yet (generators
      // are lazy), so we return a minimal handle. Caller may poll runner.get(runId).
      return {
        runId,
        workflowName: workflow.name,
        state: "running",
        createdAt: Date.now(),
        lastEventAt: Date.now(),
      };
    },

    resume(runId: string, approved: boolean): void {
      const h = registry.getInternal(runId);
      if (!h) throw new RunNotFoundError(runId);
      if (h.state !== "awaiting-checkpoint" || !h.pendingCheckpoint) {
        throw new InvalidRunStateError(runId, h.state);
      }
      if (h.pendingCheckpoint.recoveredFromStore === true) {
        throw new InvalidRunStateError(runId, h.state);
      }
      const { resolve } = h.pendingCheckpoint;
      h.clearCheckpoint();
      resolve(approved);
    },

    cancel(runId: string): void {
      const h = registry.getInternal(runId);
      if (!h) return; // idempotent
      h.abort.abort();
      if (h.pendingCheckpoint) {
        const { resolve } = h.pendingCheckpoint;
        resolve(false);
      }
      // Only mark cancelled when the run is not already in a terminal state.
      // Calling cancel() on a done/failed/cancelled run must be a no-op so the
      // terminal result is never overwritten.
      if (
        h.state !== "done" &&
        h.state !== "failed" &&
        h.state !== "cancelled"
      ) {
        h.markCancelled();
      }
    },

    get: (runId) => registry.get(runId),
    list: () => registry.list(),
    recover(workflow: WorkflowDef): void {
      for (const record of store.list()) {
        if (record.workflowName !== workflow.name) continue;
        if (
          record.state !== "running" &&
          record.state !== "awaiting-checkpoint"
        ) {
          continue;
        }
        if (replayedRunIds.has(record.runId)) continue;
        const handle = registry.getInternal(record.runId);
        if (!handle) continue;
        replayedRunIds.add(record.runId);
        void replayRecoveredRun(workflow, handle, record.input).catch(
          (err: unknown) => {
            const error =
              err instanceof Error ? err : new Error(String(err));
            handle.markFailed(error);
          },
        );
      }
    },
    async close(): Promise<void> {
      registry.close();
      await shutdownAllRunners();
    },
  };

  async function replayRecoveredRun<T extends TasksMap>(
    workflow: WorkflowDef<T>,
    handle: InternalRunHandle,
    input: unknown,
  ): Promise<void> {
    // Rehydrate the run under the same runId by replaying from the stored input.
    // The handle is already in the registry with the recovered snapshot state.
    const gen = streamImpl(workflow, input, undefined, handle.runId, handle);
    try {
      let step: IteratorResult<WorkflowEvent, WorkflowResult<T>>;
      do {
        step = await gen.next();
      } while (!step.done);
    } catch {
      // The outer catch in the caller marks the handle failed and persists it.
    }
  }
}
