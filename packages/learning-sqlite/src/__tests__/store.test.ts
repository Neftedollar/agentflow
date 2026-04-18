import { Database } from "bun:sqlite";
import type { ExecutionTrace, Feedback, SkillRecord } from "@ageflow/learning";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../migrations.js";
import { SqliteLearningStore } from "../sqlite-learning-store.js";
import { SqliteSkillStore } from "../sqlite-skill-store.js";
import { SqliteTraceStore } from "../sqlite-trace-store.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: crypto.randomUUID(),
    name: "test-skill",
    description: "A test skill",
    content: "# Skill\nDo the thing well.",
    targetAgent: "analyze",
    version: 0,
    status: "active",
    score: 0.5,
    runCount: 0,
    bestInLineage: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: crypto.randomUUID(),
    workflowName: "bug-fix",
    runAt: new Date().toISOString(),
    success: true,
    totalDurationMs: 5000,
    taskTraces: [],
    workflowInput: { file: "main.ts" },
    workflowOutput: { fixed: true },
    feedback: [],
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<Feedback> = {}): Feedback {
  return {
    rating: "positive",
    comment: "Looks good",
    source: "human",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── SqliteSkillStore tests ───────────────────────────────────────────────────

describe("SqliteSkillStore", () => {
  let db: Database;
  let store: SqliteSkillStore;

  beforeEach(() => {
    db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.run(sql);
    store = new SqliteSkillStore(db);
  });

  afterEach(() => db.close());

  it("save + get round-trips a skill", async () => {
    const skill = makeSkill();
    await store.save(skill);
    const loaded = await store.get(skill.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe(skill.name);
    expect(loaded?.content).toBe(skill.content);
    expect(loaded?.targetAgent).toBe(skill.targetAgent);
    expect(loaded?.status).toBe(skill.status);
    expect(loaded?.score).toBe(skill.score);
    expect(loaded?.runCount).toBe(skill.runCount);
    expect(loaded?.bestInLineage).toBe(skill.bestInLineage);
  });

  it("get returns null for missing id", async () => {
    const result = await store.get(crypto.randomUUID());
    expect(result).toBeNull();
  });

  it("getActiveForTask returns the active skill for a task", async () => {
    const s1 = makeSkill({ targetAgent: "fix", status: "active" });
    const s2 = makeSkill({ targetAgent: "fix", status: "retired" });
    await store.save(s1);
    await store.save(s2);
    const active = await store.getActiveForTask("fix");
    expect(active).not.toBeNull();
    expect(active?.id).toBe(s1.id);
  });

  it("getActiveForTask returns null when no active skills", async () => {
    const s1 = makeSkill({ targetAgent: "fix", status: "retired" });
    await store.save(s1);
    const active = await store.getActiveForTask("fix");
    expect(active).toBeNull();
  });

  it("getByTarget returns all skills for an agent", async () => {
    const s1 = makeSkill({ targetAgent: "agent-a" });
    const s2 = makeSkill({ targetAgent: "agent-a", status: "retired" });
    const s3 = makeSkill({ targetAgent: "agent-b" });
    await store.save(s1);
    await store.save(s2);
    await store.save(s3);
    const results = await store.getByTarget("agent-a");
    expect(results.length).toBe(2);
  });

  it("retire sets status to retired", async () => {
    const skill = makeSkill();
    await store.save(skill);
    await store.retire(skill.id);
    const loaded = await store.get(skill.id);
    expect(loaded?.status).toBe("retired");
  });

  it("delete removes the skill", async () => {
    const skill = makeSkill();
    await store.save(skill);
    await store.delete(skill.id);
    const loaded = await store.get(skill.id);
    expect(loaded).toBeNull();
  });

  it("list returns all skills", async () => {
    await store.save(makeSkill());
    await store.save(makeSkill());
    const all = await store.list();
    expect(all.length).toBe(2);
  });

  it("search finds skills by keyword (FTS5 fallback)", async () => {
    const skill = makeSkill({
      description: "root cause analysis for TypeScript",
    });
    await store.save(skill);
    const results = await store.search("root cause", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.skill.id).toBe(skill.id);
  });

  it("search returns empty array when no match", async () => {
    await store.save(makeSkill({ description: "unrelated topic" }));
    const results = await store.search("xyzzy-not-found", 10);
    expect(results.length).toBe(0);
  });

  it("getBestInLineage returns highest-scoring version", async () => {
    const v1 = makeSkill({ version: 0, score: 0.6, bestInLineage: false });
    const v2 = makeSkill({
      version: 1,
      score: 0.9,
      parentId: v1.id,
      bestInLineage: true,
    });
    const v3 = makeSkill({
      version: 2,
      score: 0.4,
      parentId: v2.id,
      bestInLineage: false,
    });
    await store.save(v1);
    await store.save(v2);
    await store.save(v3);
    const best = await store.getBestInLineage(v3.id);
    expect(best).not.toBeNull();
    expect(best?.id).toBe(v2.id);
  });

  it("getBestInLineage returns the skill itself when it has no parent", async () => {
    const skill = makeSkill({ score: 0.8, bestInLineage: true });
    await store.save(skill);
    const best = await store.getBestInLineage(skill.id);
    expect(best).not.toBeNull();
    expect(best?.id).toBe(skill.id);
  });
});

// ─── SqliteTraceStore tests ───────────────────────────────────────────────────

describe("SqliteTraceStore", () => {
  let db: Database;
  let store: SqliteTraceStore;

  beforeEach(() => {
    db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.run(sql);
    store = new SqliteTraceStore(db);
  });

  afterEach(() => db.close());

  it("save + get round-trips a trace", async () => {
    const trace = makeTrace();
    await store.saveTrace(trace);
    const loaded = await store.getTrace(trace.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.workflowName).toBe(trace.workflowName);
    expect(loaded?.success).toBe(trace.success);
    expect(loaded?.totalDurationMs).toBe(trace.totalDurationMs);
    expect(loaded?.feedback).toEqual([]);
    expect(loaded?.taskTraces).toEqual([]);
  });

  it("getTrace returns null for missing id", async () => {
    const result = await store.getTrace(crypto.randomUUID());
    expect(result).toBeNull();
  });

  it("addFeedback appends to existing trace", async () => {
    const trace = makeTrace();
    await store.saveTrace(trace);
    const fb = makeFeedback();
    await store.addFeedback(trace.id, fb);
    const loaded = await store.getTrace(trace.id);
    expect(loaded?.feedback.length).toBe(1);
    expect(loaded?.feedback[0]?.rating).toBe("positive");
  });

  it("addFeedback appends multiple feedbacks", async () => {
    const trace = makeTrace();
    await store.saveTrace(trace);
    await store.addFeedback(trace.id, makeFeedback({ rating: "positive" }));
    await store.addFeedback(
      trace.id,
      makeFeedback({ rating: "negative", comment: "actually bad" }),
    );
    const loaded = await store.getTrace(trace.id);
    expect(loaded?.feedback.length).toBe(2);
  });

  it("getTraces filters by workflowName", async () => {
    await store.saveTrace(makeTrace({ workflowName: "workflow-a" }));
    await store.saveTrace(makeTrace({ workflowName: "workflow-b" }));
    const results = await store.getTraces({ workflowName: "workflow-a" });
    expect(results.length).toBe(1);
    expect(results[0]?.workflowName).toBe("workflow-a");
  });

  it("getTraces filters by hasFeedback=true", async () => {
    const withFeedback = makeTrace();
    const noFeedback = makeTrace();
    await store.saveTrace(withFeedback);
    await store.saveTrace(noFeedback);
    await store.addFeedback(withFeedback.id, makeFeedback());
    const results = await store.getTraces({ hasFeedback: true });
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe(withFeedback.id);
  });

  it("getTraces filters by hasFeedback=false", async () => {
    const withFeedback = makeTrace();
    const noFeedback = makeTrace();
    await store.saveTrace(withFeedback);
    await store.saveTrace(noFeedback);
    await store.addFeedback(withFeedback.id, makeFeedback());
    const results = await store.getTraces({ hasFeedback: false });
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe(noFeedback.id);
  });

  it("getTraces filters by since", async () => {
    const old = makeTrace({ runAt: "2020-01-01T00:00:00.000Z" });
    const recent = makeTrace({ runAt: new Date().toISOString() });
    await store.saveTrace(old);
    await store.saveTrace(recent);
    const results = await store.getTraces({
      since: "2024-01-01T00:00:00.000Z",
    });
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe(recent.id);
  });

  it("getTraces respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.saveTrace(makeTrace());
    }
    const results = await store.getTraces({ limit: 3 });
    expect(results.length).toBe(3);
  });

  it("getTraces with no filter returns all", async () => {
    await store.saveTrace(makeTrace());
    await store.saveTrace(makeTrace());
    const results = await store.getTraces({});
    expect(results.length).toBe(2);
  });
});

// ─── SqliteLearningStore tests ────────────────────────────────────────────────

describe("SqliteLearningStore", () => {
  let store: SqliteLearningStore;

  beforeEach(() => {
    store = new SqliteLearningStore(new Database(":memory:"));
  });

  it("implements SkillStore: save + get", async () => {
    const skill = makeSkill();
    await store.save(skill);
    const loaded = await store.get(skill.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(skill.id);
  });

  it("implements TraceStore: saveTrace + getTrace", async () => {
    const trace = makeTrace();
    await store.saveTrace(trace);
    const loaded = await store.getTrace(trace.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(trace.id);
  });

  it("implements both interfaces on same database", async () => {
    const skill = makeSkill();
    const trace = makeTrace();
    await store.save(skill);
    await store.saveTrace(trace);
    const [s, t] = await Promise.all([
      store.get(skill.id),
      store.getTrace(trace.id),
    ]);
    expect(s?.id).toBe(skill.id);
    expect(t?.id).toBe(trace.id);
  });

  it("accepts a file path string", () => {
    // SqliteLearningStore should construct itself without throwing
    expect(() => new SqliteLearningStore(":memory:")).not.toThrow();
  });

  it("close() releases the sqlite handle and prevents further queries", async () => {
    const store = new SqliteLearningStore(":memory:");
    const skill = makeSkill();
    await store.save(skill);

    // Before close, queries work
    const loaded = await store.get(skill.id);
    expect(loaded).not.toBeNull();

    // After close, queries should fail
    store.close();
    await expect(store.get(skill.id)).rejects.toThrow();
  });
});
