import type { RunHandle } from "@ageflow/core";

export interface PersistedRunRecord extends RunHandle {
  readonly input?: unknown;
}

export interface RunStore {
  get(runId: string): PersistedRunRecord | undefined;
  list(): readonly PersistedRunRecord[];
  upsert(snapshot: PersistedRunRecord): void;
  delete(runId: string): void;
  close(): void;
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, PersistedRunRecord>();

  get(runId: string): PersistedRunRecord | undefined {
    const snapshot = this.runs.get(runId);
    return snapshot !== undefined ? structuredClone(snapshot) : undefined;
  }

  list(): readonly PersistedRunRecord[] {
    return [...this.runs.values()].map((snapshot) => structuredClone(snapshot));
  }

  upsert(snapshot: PersistedRunRecord): void {
    this.runs.set(snapshot.runId, structuredClone(snapshot));
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  close(): void {
    this.runs.clear();
  }
}
