import type { RunHandle } from "@ageflow/core";
import { type CreateHandleArgs, InternalRunHandle } from "./run-handle.js";

export interface RunRegistryConfig {
  readonly ttlMs: number;
  readonly checkpointTtlMs: number;
  readonly reaperIntervalMs: number;
}

export class RunRegistry {
  private readonly handles = new Map<string, InternalRunHandle>();
  private readonly cfg: RunRegistryConfig;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(cfg: RunRegistryConfig) {
    this.cfg = cfg;
    this.timer = setInterval(() => this.sweep(), cfg.reaperIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  create(args: CreateHandleArgs): InternalRunHandle {
    const h = new InternalRunHandle(args);
    this.handles.set(h.runId, h);
    return h;
  }

  getInternal(runId: string): InternalRunHandle | undefined {
    return this.handles.get(runId);
  }

  get(runId: string): RunHandle | undefined {
    return this.handles.get(runId)?.snapshot();
  }

  list(): readonly RunHandle[] {
    return [...this.handles.values()].map((h) => h.snapshot());
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, h] of this.handles) {
      if (
        h.state === "awaiting-checkpoint" &&
        now - h.lastEventAt > this.cfg.checkpointTtlMs
      ) {
        h.autoRejectCheckpoint();
        continue;
      }
      const terminal =
        h.state === "done" || h.state === "failed" || h.state === "cancelled";
      if (terminal && now - h.lastEventAt > this.cfg.ttlMs) {
        this.handles.delete(id);
      }
    }
  }
}
