import { describe, expect, it } from "vitest";
import {
  ExecutionTraceSchema,
  FeedbackSchema,
  SkillRecordSchema,
  TaskTraceSchema,
} from "../types.js";

describe("FeedbackSchema", () => {
  it("accepts valid feedback", () => {
    const result = FeedbackSchema.safeParse({
      rating: "negative",
      comment: "PR rejected",
      source: "human",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid rating", () => {
    const result = FeedbackSchema.safeParse({
      rating: "terrible",
      source: "human",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe("SkillRecordSchema", () => {
  it("accepts valid skill record", () => {
    const result = SkillRecordSchema.safeParse({
      id: crypto.randomUUID(),
      name: "analyze-root-cause-v1",
      description: "Improved root cause analysis",
      content: "# Skill\nAlways check adjacent modules...",
      targetAgent: "analyze",
      version: 1,
      parentId: undefined,
      status: "active",
      score: 0.8,
      runCount: 5,
      bestInLineage: true,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects score > 1", () => {
    const result = SkillRecordSchema.safeParse({
      id: crypto.randomUUID(),
      name: "test",
      description: "test",
      content: "test",
      targetAgent: "test",
      version: 0,
      status: "active",
      score: 1.5,
      runCount: 0,
      bestInLineage: false,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe("ExecutionTraceSchema", () => {
  it("accepts valid trace with empty feedback", () => {
    const result = ExecutionTraceSchema.safeParse({
      id: crypto.randomUUID(),
      workflowName: "bug-fix",
      runAt: new Date().toISOString(),
      success: true,
      totalDurationMs: 5000,
      taskTraces: [],
      workflowInput: { file: "main.ts" },
      workflowOutput: { fixed: true },
      feedback: [],
    });
    expect(result.success).toBe(true);
  });
});
