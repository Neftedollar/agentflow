import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { PersistedRunRecord, RunStore } from "@ageflow/server";

interface SnapshotRow {
  readonly payload: string;
}

interface SqliteStatement {
  run(params?: unknown): unknown;
  get(params?: unknown): unknown;
  all(params?: unknown): unknown;
}

interface SqliteAdapter {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function createSqliteAdapter(dbPath: string): SqliteAdapter {
  const require = createRequire(import.meta.url);

  try {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath, { create: true });
    return {
      exec(sql: string): void {
        db.query(sql).run();
      },
      prepare(sql: string): SqliteStatement {
        const stmt = db.query(sql);
        return {
          run(params?: unknown): unknown {
            return stmt.run(params as any);
          },
          get(params?: unknown): unknown {
            return stmt.get(params as any);
          },
          all(params?: unknown): unknown {
            return stmt.all(params as any);
          },
        };
      },
      close(): void {
        db.close(false);
      },
    };
  } catch {
    const { DatabaseSync } = require("node:sqlite") as typeof import(
      "node:sqlite"
    );
    const db = new DatabaseSync(dbPath);
    return {
      exec(sql: string): void {
        db.exec(sql);
      },
      prepare(sql: string): SqliteStatement {
        const stmt = db.prepare(sql);
        return {
          run(params?: unknown): unknown {
            return stmt.run((params ?? {}) as any);
          },
          get(params?: unknown): unknown {
            return stmt.get((params ?? {}) as any) as unknown;
          },
          all(params?: unknown): unknown {
            return stmt.all((params ?? {}) as any) as unknown;
          },
        };
      },
      close(): void {
        db.close();
      },
    };
  }
}

export class SqliteRunStore implements RunStore {
  private readonly db: SqliteAdapter;
  private readonly getStmt: SqliteStatement;
  private readonly listStmt: SqliteStatement;
  private readonly upsertStmt: SqliteStatement;
  private readonly deleteStmt: SqliteStatement;
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:" && dbPath !== "") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = createSqliteAdapter(dbPath);
    if (dbPath !== ":memory:" && dbPath !== "") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          runId TEXT PRIMARY KEY,
          lastEventAt INTEGER NOT NULL,
          payload TEXT NOT NULL
        )
      `);
    this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_runs_lastEventAt
        ON runs(lastEventAt)
      `);

    this.getStmt = this.db.prepare(
      "SELECT payload FROM runs WHERE runId = $runId",
    );
    this.listStmt = this.db.prepare(
      "SELECT payload FROM runs ORDER BY lastEventAt DESC",
    );
    this.upsertStmt = this.db.prepare(`
      INSERT INTO runs (runId, lastEventAt, payload)
      VALUES ($runId, $lastEventAt, $payload)
      ON CONFLICT(runId) DO UPDATE SET
        lastEventAt = excluded.lastEventAt,
        payload = excluded.payload
    `);
    this.deleteStmt = this.db.prepare("DELETE FROM runs WHERE runId = $runId");
  }

  private ensureOpen(): boolean {
    return !this.closed;
  }

  private parseSnapshot(
    row: SnapshotRow | undefined,
  ): PersistedRunRecord | undefined {
    if (!row) return undefined;
    return JSON.parse(row.payload) as PersistedRunRecord;
  }

  get(runId: string): PersistedRunRecord | undefined {
    if (!this.ensureOpen()) return undefined;
    return this.parseSnapshot(
      this.getStmt.get({ $runId: runId }) as SnapshotRow | undefined,
    );
  }

  list(): readonly PersistedRunRecord[] {
    if (!this.ensureOpen()) return [];
    return (this.listStmt.all() as SnapshotRow[]).map(
      (row) => JSON.parse(row.payload) as PersistedRunRecord,
    );
  }

  upsert(snapshot: PersistedRunRecord): void {
    if (!this.ensureOpen()) return;
    this.upsertStmt.run({
      $runId: snapshot.runId,
      $lastEventAt: snapshot.lastEventAt,
      $payload: JSON.stringify(snapshot),
    });
  }

  delete(runId: string): void {
    if (!this.ensureOpen()) return;
    this.deleteStmt.run({ $runId: runId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
