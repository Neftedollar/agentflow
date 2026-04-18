import { Database } from "bun:sqlite";
import type {
  ExecutionTrace,
  Feedback,
  ScoredSkill,
  SkillRecord,
  SkillStore,
  TraceFilter,
  TraceStore,
} from "@ageflow/learning";
import {
  MIGRATIONS,
  detectVecDistanceMetric,
  makeVecTableSql,
} from "./migrations.js";
import { SqliteSkillStore } from "./sqlite-skill-store.js";
import { SqliteTraceStore } from "./sqlite-trace-store.js";

// ─── sqlite-vec extension loading ─────────────────────────────────────────────

/**
 * Default embedding dimension for vec0 virtual table.
 * Must match the dimension of embeddings stored in SkillRecord.embedding.
 * Override via SqliteLearningStoreOptions.embeddingDimensions.
 */
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/**
 * Attempt to load the sqlite-vec extension.
 * Returns true if loaded successfully, false otherwise.
 * Emits a PERMANENT warning on every failed load — callers should not suppress
 * this (per spec §2.4: consumers must not be silently degraded).
 */
function tryLoadVec(db: Database, dimensions: number): boolean {
  try {
    // sqlite-vec ships the extension as "vec0" (the module entrypoint)
    db.loadExtension("vec0");

    // Detect whether an existing skills_vec table uses the wrong distance
    // metric. Databases created before PR #200 use L2 (vec0 default) or have
    // no distance_metric clause. Either case must be migrated to cosine.
    const existing = detectVecDistanceMetric(db);
    if (existing !== null && existing !== "cosine") {
      console.warn(
        `[learning-sqlite] migrating skills_vec from ${existing} → cosine distance. Existing embeddings will be repopulated.`,
      );
      // Wrap the destructive migration in a transaction so that a failure
      // during DROP/CREATE/INSERT rolls back atomically — the original table
      // is preserved rather than left in a corrupt/absent state.
      db.transaction(() => {
        const oldRows = db
          .query<{ skill_id: string; embedding: Buffer }, []>(
            "SELECT skill_id, embedding FROM skills_vec",
          )
          .all();
        db.exec("DROP TABLE skills_vec");
        db.exec(makeVecTableSql(dimensions));
        const insert = db.prepare(
          "INSERT INTO skills_vec (skill_id, embedding) VALUES (?, ?)",
        );
        for (const row of oldRows) insert.run(row.skill_id, row.embedding);
      })();
    } else {
      // No existing table or already cosine — create if absent (IF NOT EXISTS).
      db.run(makeVecTableSql(dimensions));
    }

    return true;
  } catch (err) {
    // PERMANENT warning — fires every init when extension is missing.
    // This is intentional: silent fallback would hide a misconfiguration.
    console.warn(
      `[learning-sqlite] sqlite-vec extension failed to load — semantic search will fall back to FTS5 keyword matching. Install sqlite-vec (https://github.com/asg017/sqlite-vec) and ensure the vec0 shared library is on the extension search path to enable embedding-based skill retrieval. Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// ─── SqliteLearningStore options ──────────────────────────────────────────────

export interface SqliteLearningStoreOptions {
  /**
   * Number of dimensions in the embedding vectors stored in SkillRecord.
   * Must match the model used to produce embeddings.
   * @default 1536
   */
  embeddingDimensions?: number;
}

// ─── SqliteLearningStore ──────────────────────────────────────────────────────

/**
 * Convenience wrapper — single SQLite database backing both stores.
 * Implements SkillStore & TraceStore.
 *
 * At construction time, attempts to load the sqlite-vec extension for
 * embedding-based KNN search. If the extension is unavailable, a PERMANENT
 * warning is emitted and the store falls back to FTS5 keyword search.
 *
 * Embeddings are an external concern — this package stores and searches them
 * but does not generate them. Produce embeddings upstream (e.g. via the
 * reflection workflow) and pass them in via SkillRecord.embedding.
 */
export class SqliteLearningStore implements SkillStore, TraceStore {
  private readonly db: Database;
  private readonly skillStore: SqliteSkillStore;
  private readonly traceStore: SqliteTraceStore;
  /** Whether the sqlite-vec extension loaded successfully at init. */
  readonly vecAvailable: boolean;

  constructor(
    pathOrDb: string | Database,
    options: SqliteLearningStoreOptions = {},
  ) {
    this.db = typeof pathOrDb === "string" ? new Database(pathOrDb) : pathOrDb;
    const dimensions =
      options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;

    // Run base schema migrations first (skills, fts5, traces)
    for (const sql of MIGRATIONS) this.db.run(sql);

    // Attempt sqlite-vec extension load (permanent warning on failure)
    this.vecAvailable = tryLoadVec(this.db, dimensions);

    this.skillStore = new SqliteSkillStore(this.db, this.vecAvailable);
    this.traceStore = new SqliteTraceStore(this.db);
  }

  // ─── SkillStore delegation ─────────────────────────────────────────────────

  save(skill: SkillRecord): Promise<void> {
    return this.skillStore.save(skill);
  }

  get(id: string): Promise<SkillRecord | null> {
    return this.skillStore.get(id);
  }

  getByTarget(
    targetAgent: string,
    targetWorkflow?: string,
  ): Promise<SkillRecord[]> {
    return this.skillStore.getByTarget(targetAgent, targetWorkflow);
  }

  getActiveForTask(
    taskName: string,
    workflowName?: string,
  ): Promise<SkillRecord | null> {
    return this.skillStore.getActiveForTask(taskName, workflowName);
  }

  getBestInLineage(skillId: string): Promise<SkillRecord | null> {
    return this.skillStore.getBestInLineage(skillId);
  }

  search(
    query: string,
    limit: number,
    queryEmbedding?: Float32Array,
  ): Promise<ScoredSkill[]> {
    return this.skillStore.search(query, limit, queryEmbedding);
  }

  list(): Promise<SkillRecord[]> {
    return this.skillStore.list();
  }

  retire(id: string): Promise<void> {
    return this.skillStore.retire(id);
  }

  delete(id: string): Promise<void> {
    return this.skillStore.delete(id);
  }

  // ─── TraceStore delegation ─────────────────────────────────────────────────

  saveTrace(trace: ExecutionTrace): Promise<void> {
    return this.traceStore.saveTrace(trace);
  }

  getTrace(id: string): Promise<ExecutionTrace | null> {
    return this.traceStore.getTrace(id);
  }

  getTraces(filter: TraceFilter): Promise<ExecutionTrace[]> {
    return this.traceStore.getTraces(filter);
  }

  addFeedback(traceId: string, feedback: Feedback): Promise<void> {
    return this.traceStore.addFeedback(traceId, feedback);
  }

  // ─── Resource lifecycle ────────────────────────────────────────────────────

  /**
   * Release the underlying SQLite database handle.
   * After calling close(), all subsequent store operations will throw.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Support for explicit resource management via `await using`.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
}
