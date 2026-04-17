import type { Database } from "bun:sqlite";
import type {
  ExecutionTrace,
  Feedback,
  TraceFilter,
  TraceStore,
} from "@ageflow/learning";

// ─── Row type from SQLite ─────────────────────────────────────────────────────

interface TraceRow {
  id: string;
  workflow_name: string;
  run_at: string;
  success: number;
  total_duration_ms: number;
  task_traces: string;
  workflow_input: string | null;
  workflow_output: string | null;
  feedback: string;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function rowToTrace(row: TraceRow): ExecutionTrace {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    runAt: row.run_at,
    success: row.success === 1,
    totalDurationMs: row.total_duration_ms,
    taskTraces: JSON.parse(row.task_traces) as ExecutionTrace["taskTraces"],
    workflowInput:
      row.workflow_input !== null
        ? (JSON.parse(row.workflow_input) as unknown)
        : undefined,
    workflowOutput:
      row.workflow_output !== null
        ? (JSON.parse(row.workflow_output) as unknown)
        : undefined,
    feedback: JSON.parse(row.feedback) as Feedback[],
  };
}

// ─── SqliteTraceStore ─────────────────────────────────────────────────────────

export class SqliteTraceStore implements TraceStore {
  constructor(private readonly db: Database) {}

  async saveTrace(trace: ExecutionTrace): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO traces
           (id, workflow_name, run_at, success, total_duration_ms,
            task_traces, workflow_input, workflow_output, feedback)
         VALUES
           ($id, $workflowName, $runAt, $success, $totalDurationMs,
            $taskTraces, $workflowInput, $workflowOutput, $feedback)`,
      )
      .run({
        $id: trace.id,
        $workflowName: trace.workflowName,
        $runAt: trace.runAt,
        $success: trace.success ? 1 : 0,
        $totalDurationMs: trace.totalDurationMs,
        $taskTraces: JSON.stringify(trace.taskTraces),
        $workflowInput:
          trace.workflowInput !== undefined
            ? JSON.stringify(trace.workflowInput)
            : null,
        $workflowOutput:
          trace.workflowOutput !== undefined
            ? JSON.stringify(trace.workflowOutput)
            : null,
        $feedback: JSON.stringify(trace.feedback),
      });
  }

  async getTrace(id: string): Promise<ExecutionTrace | null> {
    const row = this.db
      .query<TraceRow, { $id: string }>("SELECT * FROM traces WHERE id = $id")
      .get({ $id: id });
    return row ? rowToTrace(row) : null;
  }

  async getTraces(filter: TraceFilter): Promise<ExecutionTrace[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.workflowName !== undefined) {
      conditions.push("workflow_name = $workflowName");
      params.$workflowName = filter.workflowName;
    }

    if (filter.since !== undefined) {
      conditions.push("run_at >= $since");
      params.$since = filter.since;
    }

    if (filter.hasFeedback === true) {
      conditions.push("feedback != '[]'");
    } else if (filter.hasFeedback === false) {
      conditions.push("feedback = '[]'");
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    if (filter.limit !== undefined) {
      params.$limit = filter.limit;
    }
    const limitClause = filter.limit !== undefined ? "LIMIT $limit" : "";

    const rows = this.db
      .prepare<TraceRow, Record<string, string | number | null | boolean>>(
        `SELECT * FROM traces ${where} ORDER BY run_at DESC ${limitClause}`,
      )
      .all(params as Record<string, string | number | null | boolean>);

    return rows.map(rowToTrace);
  }

  async addFeedback(traceId: string, feedback: Feedback): Promise<void> {
    const row = this.db
      .query<{ feedback: string }, { $id: string }>(
        "SELECT feedback FROM traces WHERE id = $id",
      )
      .get({ $id: traceId });

    if (!row) {
      throw new Error(`Trace not found: ${traceId}`);
    }

    const existing = JSON.parse(row.feedback) as Feedback[];
    existing.push(feedback);

    this.db
      .query<null, { $feedback: string; $id: string }>(
        "UPDATE traces SET feedback = $feedback WHERE id = $id",
      )
      .run({ $feedback: JSON.stringify(existing), $id: traceId });
  }
}
