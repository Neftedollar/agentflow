import { describe, expect, it, vi } from "vitest";
import { createLearningHooks } from "../hooks.js";
import type { SkillStore, TraceStore } from "../interfaces.js";
import type {
  ExecutionTrace,
  Feedback,
  ScoredSkill,
  SkillRecord,
  TraceFilter,
} from "../types.js";

// ─── In-memory mock stores ────────────────────────────────────────────────────

function makeSkillRecord(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: crypto.randomUUID(),
    name: "test-skill",
    description: "A test skill",
    content: "Always check adjacent modules first.",
    targetAgent: "analyze",
    targetWorkflow: "bug-fix",
    version: 1,
    status: "active",
    score: 0.8,
    runCount: 5,
    bestInLineage: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSkillStore(activeSkill: SkillRecord | null = null): SkillStore {
  const records = new Map<string, SkillRecord>();
  if (activeSkill) records.set(activeSkill.id, activeSkill);
  return {
    save: vi.fn(async (skill: SkillRecord) => {
      records.set(skill.id, skill);
    }),
    get: vi.fn(async (id: string) => records.get(id) ?? null),
    getByTarget: vi.fn(async () => [...records.values()]),
    getActiveForTask: vi.fn(async () => activeSkill),
    getBestInLineage: vi.fn(async () => null),
    search: vi.fn(async (): Promise<ScoredSkill[]> => []),
    list: vi.fn(async () => [...records.values()]),
    retire: vi.fn(async () => {}),
    delete: vi.fn(async (id: string) => {
      records.delete(id);
    }),
  };
}

function makeTraceStore(): TraceStore & { traces: ExecutionTrace[] } {
  const traces: ExecutionTrace[] = [];
  return {
    traces,
    saveTrace: vi.fn(async (trace: ExecutionTrace) => {
      traces.push(trace);
    }),
    getTrace: vi.fn(
      async (id: string) => traces.find((t) => t.id === id) ?? null,
    ),
    getTraces: vi.fn(async (_filter: TraceFilter) => traces),
    addFeedback: vi.fn(async (_traceId: string, _feedback: Feedback) => {}),
  };
}

const makeMetrics = () => ({
  totalLatencyMs: 1000,
  totalTokensIn: 100,
  totalTokensOut: 50,
  totalEstimatedCost: 0.01,
  taskCount: 1,
});

const makeTaskMetrics = () => ({
  tokensIn: 100,
  tokensOut: 50,
  latencyMs: 500,
  retries: 0,
  estimatedCost: 0.005,
  promptSent: "test prompt",
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createLearningHooks", () => {
  it("returns a valid WorkflowHooks object with expected hook properties", () => {
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore: makeTraceStore(),
      workflowName: "test-workflow",
    });

    expect(hooks).toBeDefined();
    expect(typeof hooks.onTaskStart).toBe("function");
    expect(typeof hooks.getSystemPromptPrefix).toBe("function");
    expect(typeof hooks.onTaskComplete).toBe("function");
    expect(typeof hooks.onTaskError).toBe("function");
    expect(typeof hooks.onWorkflowComplete).toBe("function");
  });

  it("getSystemPromptPrefix returns skill content when active skill exists", async () => {
    const skill = makeSkillRecord({ content: "Use structured output always." });
    const skillStore = makeSkillStore(skill);
    const hooks = createLearningHooks({
      skillStore,
      traceStore: makeTraceStore(),
      workflowName: "bug-fix",
    });

    // Trigger cache population then await the async result directly
    hooks.onTaskStart?.("analyze");
    const result = await hooks.getSystemPromptPrefix?.("analyze");
    expect(result).toBe("Use structured output always.");
  });

  it("getSystemPromptPrefix returns undefined when no skill exists", async () => {
    const skillStore = makeSkillStore(null);
    const hooks = createLearningHooks({
      skillStore,
      traceStore: makeTraceStore(),
      workflowName: "bug-fix",
    });

    hooks.onTaskStart?.("analyze");
    const result = await hooks.getSystemPromptPrefix?.("analyze");
    expect(result).toBeUndefined();
  });

  it("onWorkflowComplete saves ExecutionTrace to traceStore", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "bug-fix",
    });

    hooks.onTaskStart?.("analyze");
    hooks.onTaskComplete?.("analyze", { fixed: true }, makeTaskMetrics());
    await hooks.onWorkflowComplete?.({ fixed: true }, makeMetrics());

    expect(traceStore.traces).toHaveLength(1);
    const trace = traceStore.traces[0];
    expect(trace.workflowName).toBe("bug-fix");
    expect(trace.success).toBe(true);
    expect(trace.taskTraces).toHaveLength(1);
    expect(trace.workflowOutput).toEqual({ fixed: true });
  });

  it("TaskTrace includes skillsApplied when a skill was active", async () => {
    const skill = makeSkillRecord({ content: "Always verify." });
    const skillStore = makeSkillStore(skill);
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore,
      traceStore,
      workflowName: "bug-fix",
    });

    // Pre-populate cache and await the async result
    hooks.onTaskStart?.("analyze");
    await hooks.getSystemPromptPrefix?.("analyze");

    hooks.onTaskComplete?.("analyze", "output text", makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    const trace = traceStore.traces[0];
    expect(trace.taskTraces[0].skillsApplied).toContain("analyze");
  });

  it("TaskTrace does not include skillsApplied when no skill was active", async () => {
    const skillStore = makeSkillStore(null);
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore,
      traceStore,
      workflowName: "bug-fix",
    });

    hooks.onTaskStart?.("analyze");
    await hooks.getSystemPromptPrefix?.("analyze");

    hooks.onTaskComplete?.("analyze", "output", makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    const trace = traceStore.traces[0];
    expect(trace.taskTraces[0].skillsApplied).toHaveLength(0);
  });

  it("multiple runs reset task traces correctly", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "bug-fix",
    });

    // Run 1
    hooks.onTaskStart?.("taskA");
    hooks.onTaskComplete?.("taskA", "out1", makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    // Run 2
    hooks.onTaskStart?.("taskB");
    hooks.onTaskComplete?.("taskB", "out2", makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    // Each trace should only have one task from that run
    expect(traceStore.traces).toHaveLength(2);
    expect(traceStore.traces[0].taskTraces).toHaveLength(1);
    expect(traceStore.traces[0].taskTraces[0].taskName).toBe("taskA");
    expect(traceStore.traces[1].taskTraces).toHaveLength(1);
    expect(traceStore.traces[1].taskTraces[0].taskName).toBe("taskB");
  });

  it("onTaskError records failed TaskTrace", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "bug-fix",
    });

    hooks.onTaskStart?.("analyze");
    hooks.onTaskError?.("analyze", new Error("timeout"), 2);
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    const trace = traceStore.traces[0];
    expect(trace.taskTraces[0].success).toBe(false);
    expect(trace.taskTraces[0].output).toBe("timeout");
    expect(trace.taskTraces[0].retryCount).toBe(2);
  });
});
