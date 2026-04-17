import type {
  ExecutionTrace,
  Feedback,
  ScoredSkill,
  SkillRecord,
  TraceFilter,
} from "./types.js";

/** Persistent storage for learned skills. */
export interface SkillStore {
  save(skill: SkillRecord): Promise<void>;
  get(id: string): Promise<SkillRecord | null>;
  getByTarget(
    targetAgent: string,
    targetWorkflow?: string,
  ): Promise<SkillRecord[]>;
  getActiveForTask(
    taskName: string,
    workflowName?: string,
  ): Promise<SkillRecord | null>;
  getBestInLineage(skillId: string): Promise<SkillRecord | null>;
  search(query: string, limit: number): Promise<ScoredSkill[]>;
  list(): Promise<SkillRecord[]>;
  retire(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Persistent storage for workflow execution traces + feedback. */
export interface TraceStore {
  saveTrace(trace: ExecutionTrace): Promise<void>;
  getTrace(id: string): Promise<ExecutionTrace | null>;
  getTraces(filter: TraceFilter): Promise<ExecutionTrace[]>;
  addFeedback(traceId: string, feedback: Feedback): Promise<void>;
}
