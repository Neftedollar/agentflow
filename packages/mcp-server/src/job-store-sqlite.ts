import type { JobStore, PersistedJob } from "./job-store.js";

export async function createSqliteJobStore(dbPath: string): Promise<JobStore> {
  const { SqliteRunStore } = await import(
    /* @vite-ignore */ "@ageflow/server-sqlite"
  );
  return new SqliteRunStore(dbPath) as unknown as JobStore;
}
