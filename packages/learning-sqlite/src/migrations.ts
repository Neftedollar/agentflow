/** SQL statements to initialize the learning database schema. */
export const MIGRATIONS = [
  // Skills table
  `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    content TEXT NOT NULL,
    target_agent TEXT NOT NULL,
    target_workflow TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'retired')),
    score REAL NOT NULL DEFAULT 0.5,
    run_count INTEGER NOT NULL DEFAULT 0,
    best_in_lineage INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES skills(id)
  )`,

  // Index for task+workflow lookup
  `CREATE INDEX IF NOT EXISTS idx_skills_target
   ON skills(target_agent, target_workflow, status)`,

  // FTS5 for keyword search fallback (stored content — simpler than external content table)
  `CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    skill_id UNINDEXED, name, description
  )`,

  // Traces table
  `CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    run_at TEXT NOT NULL,
    success INTEGER NOT NULL,
    total_duration_ms INTEGER NOT NULL,
    task_traces TEXT NOT NULL,
    workflow_input TEXT,
    workflow_output TEXT,
    feedback TEXT NOT NULL DEFAULT '[]'
  )`,

  // Index for workflow lookup
  `CREATE INDEX IF NOT EXISTS idx_traces_workflow
   ON traces(workflow_name, run_at DESC)`,
] as const;

/**
 * SQL to create the sqlite-vec virtual table for embedding-based KNN search.
 * Dimension must match the embedding size stored in SkillRecord.embedding.
 * Only executed when the sqlite-vec extension is successfully loaded.
 */
export function makeVecTableSql(dimensions: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS skills_vec USING vec0(
    skill_id TEXT PRIMARY KEY,
    embedding float[${dimensions}] distance_metric=cosine
  )`;
}

/**
 * Inspect the existing skills_vec table (if any) to detect its distance metric.
 *
 * Returns:
 *   null      — no skills_vec table exists yet (fresh database)
 *   "cosine"  — table exists and uses distance_metric=cosine
 *   "L2"      — table exists and explicitly declares distance_metric=L2
 *   "unknown" — table exists but CREATE SQL contains no distance_metric clause
 *               (vec0 default is L2, so this also needs migration)
 *
 * Detection is done by parsing the raw DDL stored in sqlite_master — vec0 does
 * not expose the metric via PRAGMA, so this is the only reliable approach.
 */
export function detectVecDistanceMetric(
  db: import("bun:sqlite").Database,
): "cosine" | "L2" | "unknown" | null {
  const row = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='skills_vec'",
    )
    .get();
  if (!row) return null;
  if (row.sql.includes("distance_metric=cosine")) return "cosine";
  if (row.sql.includes("distance_metric=L2")) return "L2";
  // No distance_metric clause — vec0 defaults to L2.
  return "unknown";
}
