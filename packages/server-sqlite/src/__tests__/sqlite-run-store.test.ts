import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowMetrics } from "@ageflow/core";
import type { PersistedRunRecord } from "@ageflow/server";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRunStore } from "../sqlite-run-store.js";

function makeMetrics(): WorkflowMetrics {
  return {
    totalLatencyMs: 100,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalEstimatedCost: 0,
    taskCount: 1,
  };
}

function makeSnapshot(
  overrides: Partial<PersistedRunRecord> = {},
): PersistedRunRecord {
  return {
    runId: crypto.randomUUID(),
    workflowName: "test-workflow",
    state: "done",
    createdAt: 1_700_000_000_000,
    lastEventAt: 1_700_000_000_000,
    input: { persisted: true },
    result: {
      outputs: { ok: true },
      metrics: makeMetrics(),
    },
    ...overrides,
  };
}

describe("SqliteRunStore", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("round-trips snapshots through sqlite", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ageflow-run-store-"));
    const store = new SqliteRunStore(path.join(tmpDir, "runs.sqlite"));
    const snapshot = makeSnapshot();

    store.upsert(snapshot);

    expect(store.get(snapshot.runId)).toEqual(snapshot);
    expect(store.list()).toEqual([snapshot]);

    store.close();
  });

  it("orders list by last event time and deletes entries", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ageflow-run-store-"));
    const store = new SqliteRunStore(path.join(tmpDir, "runs.sqlite"));
    const older = makeSnapshot({ runId: "older", lastEventAt: 1 });
    const newer = makeSnapshot({ runId: "newer", lastEventAt: 2 });

    store.upsert(older);
    store.upsert(newer);

    expect(store.list().map((snapshot) => snapshot.runId)).toEqual([
      "newer",
      "older",
    ]);

    store.delete(older.runId);
    expect(store.get(older.runId)).toBeUndefined();

    store.close();
  });

  it("becomes inert after close", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ageflow-run-store-"));
    const store = new SqliteRunStore(path.join(tmpDir, "runs.sqlite"));
    const snapshot = makeSnapshot();

    store.upsert(snapshot);
    store.close();

    expect(store.get(snapshot.runId)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("reopens the same database with the persisted row intact", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ageflow-run-store-"));
    const dbPath = path.join(tmpDir, "runs.sqlite");
    const snapshot = makeSnapshot();

    const first = new SqliteRunStore(dbPath);
    first.upsert(snapshot);
    first.close();

    const second = new SqliteRunStore(dbPath);
    expect(second.get(snapshot.runId)).toEqual(snapshot);
    expect(second.list()).toEqual([snapshot]);
    second.close();
  });
});
