import type { Database } from "bun:sqlite";
import type { ScoredSkill, SkillRecord, SkillStore } from "@ageflow/learning";

// ─── Row type from SQLite ─────────────────────────────────────────────────────

interface SkillRow {
  id: string;
  name: string;
  description: string;
  content: string;
  target_agent: string;
  target_workflow: string | null;
  version: number;
  parent_id: string | null;
  status: "active" | "retired";
  score: number;
  run_count: number;
  best_in_lineage: number;
  created_at: string;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function rowToRecord(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    targetAgent: row.target_agent,
    targetWorkflow: row.target_workflow ?? undefined,
    version: row.version,
    parentId: row.parent_id ?? undefined,
    status: row.status,
    score: row.score,
    runCount: row.run_count,
    bestInLineage: row.best_in_lineage === 1,
    createdAt: row.created_at,
  };
}

// ─── SqliteSkillStore ─────────────────────────────────────────────────────────

export class SqliteSkillStore implements SkillStore {
  constructor(private readonly db: Database) {}

  async save(skill: SkillRecord): Promise<void> {
    // Insert or replace in skills table
    this.db
      .query(
        `INSERT OR REPLACE INTO skills
           (id, name, description, content, target_agent, target_workflow,
            version, parent_id, status, score, run_count, best_in_lineage, created_at)
         VALUES
           ($id, $name, $description, $content, $targetAgent, $targetWorkflow,
            $version, $parentId, $status, $score, $runCount, $bestInLineage, $createdAt)`,
      )
      .run({
        $id: skill.id,
        $name: skill.name,
        $description: skill.description,
        $content: skill.content,
        $targetAgent: skill.targetAgent,
        $targetWorkflow: skill.targetWorkflow ?? null,
        $version: skill.version,
        $parentId: skill.parentId ?? null,
        $status: skill.status,
        $score: skill.score,
        $runCount: skill.runCount,
        $bestInLineage: skill.bestInLineage ? 1 : 0,
        $createdAt: skill.createdAt,
      });

    // Sync FTS5: remove old entry if exists, insert fresh
    this.db
      .query("DELETE FROM skills_fts WHERE skill_id = $id")
      .run({ $id: skill.id });
    this.db
      .query(
        `INSERT INTO skills_fts(skill_id, name, description)
         VALUES ($id, $name, $description)`,
      )
      .run({
        $id: skill.id,
        $name: skill.name,
        $description: skill.description,
      });
  }

  async get(id: string): Promise<SkillRecord | null> {
    const row = this.db
      .query<SkillRow, { $id: string }>("SELECT * FROM skills WHERE id = $id")
      .get({ $id: id });
    return row ? rowToRecord(row) : null;
  }

  async getByTarget(
    targetAgent: string,
    targetWorkflow?: string,
  ): Promise<SkillRecord[]> {
    let rows: SkillRow[];
    if (targetWorkflow !== undefined) {
      rows = this.db
        .query<SkillRow, { $agent: string; $workflow: string }>(
          `SELECT * FROM skills
           WHERE target_agent = $agent AND target_workflow = $workflow
           ORDER BY score DESC`,
        )
        .all({ $agent: targetAgent, $workflow: targetWorkflow });
    } else {
      rows = this.db
        .query<SkillRow, { $agent: string }>(
          `SELECT * FROM skills
           WHERE target_agent = $agent
           ORDER BY score DESC`,
        )
        .all({ $agent: targetAgent });
    }
    return rows.map(rowToRecord);
  }

  async getActiveForTask(
    taskName: string,
    workflowName?: string,
  ): Promise<SkillRecord | null> {
    let row: SkillRow | null;
    if (workflowName !== undefined) {
      row = this.db
        .query<SkillRow, { $agent: string; $workflow: string }>(
          `SELECT * FROM skills
           WHERE target_agent = $agent
             AND target_workflow = $workflow
             AND status = 'active'
           ORDER BY score DESC
           LIMIT 1`,
        )
        .get({ $agent: taskName, $workflow: workflowName });
    } else {
      row = this.db
        .query<SkillRow, { $agent: string }>(
          `SELECT * FROM skills
           WHERE target_agent = $agent AND status = 'active'
           ORDER BY score DESC
           LIMIT 1`,
        )
        .get({ $agent: taskName });
    }
    return row ? rowToRecord(row) : null;
  }

  async getBestInLineage(skillId: string): Promise<SkillRecord | null> {
    // Step 1: traverse UP the parent chain to find the root of the lineage.
    let rootId: string = skillId;
    let currentId: string | null = skillId;

    while (currentId !== null) {
      rootId = currentId;
      const parentRow = this.db
        .query<{ parent_id: string | null }, { $id: string }>(
          "SELECT parent_id FROM skills WHERE id = $id",
        )
        .get({ $id: currentId });
      currentId = parentRow?.parent_id ?? null;
    }

    // Step 2: traverse DOWN from the root using a recursive CTE to collect
    // all descendants, then return the one with the highest score.
    const row = this.db
      .query<SkillRow, { $rootId: string }>(
        `WITH RECURSIVE lineage(id) AS (
           SELECT id FROM skills WHERE id = $rootId
           UNION ALL
           SELECT s.id FROM skills s JOIN lineage l ON s.parent_id = l.id
         )
         SELECT * FROM skills
         WHERE id IN (SELECT id FROM lineage)
         ORDER BY score DESC
         LIMIT 1`,
      )
      .get({ $rootId: rootId });

    return row ? rowToRecord(row) : null;
  }

  async search(query: string, limit: number): Promise<ScoredSkill[]> {
    interface FtsRow {
      skill_id: string;
      rank: number;
    }

    // Wrap the query in double-quotes to treat it as a phrase literal,
    // avoiding FTS5 keyword conflicts (NOT, AND, OR, etc.)
    const safeQuery = `"${query.replace(/"/g, '""')}"`;

    const ftsRows = this.db
      .query<FtsRow, { $query: string; $limit: number }>(
        `SELECT skill_id, rank
         FROM skills_fts
         WHERE skills_fts MATCH $query
         ORDER BY rank
         LIMIT $limit`,
      )
      .all({ $query: safeQuery, $limit: limit });

    const results: ScoredSkill[] = [];
    for (const ftsRow of ftsRows) {
      const skillRow = this.db
        .query<SkillRow, { $id: string }>("SELECT * FROM skills WHERE id = $id")
        .get({ $id: ftsRow.skill_id });
      if (skillRow) {
        results.push({
          skill: rowToRecord(skillRow),
          // FTS5 rank is negative; normalize to [0,1] relevance heuristic
          relevance: Math.max(0, Math.min(1, 1 / (1 + Math.abs(ftsRow.rank)))),
        });
      }
    }

    return results;
  }

  async list(): Promise<SkillRecord[]> {
    const rows = this.db
      .query<SkillRow, never[]>("SELECT * FROM skills ORDER BY created_at DESC")
      .all();
    return rows.map(rowToRecord);
  }

  async retire(id: string): Promise<void> {
    this.db
      .query<null, { $id: string }>(
        `UPDATE skills SET status = 'retired' WHERE id = $id`,
      )
      .run({ $id: id });
  }

  async delete(id: string): Promise<void> {
    // Clean up FTS5 first
    this.db
      .query("DELETE FROM skills_fts WHERE skill_id = $id")
      .run({ $id: id });
    this.db
      .query<null, { $id: string }>("DELETE FROM skills WHERE id = $id")
      .run({ $id: id });
  }
}
