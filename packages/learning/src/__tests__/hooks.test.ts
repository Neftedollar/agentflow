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
import * as reflectionModule from "../workflows/reflection.js";

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
    hooks.onTaskStart?.("analyze", "api");
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

    hooks.onTaskStart?.("analyze", "api");
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

    hooks.onTaskStart?.("analyze", "api");
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
    hooks.onTaskStart?.("analyze", "api");
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

    hooks.onTaskStart?.("analyze", "api");
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
    hooks.onTaskStart?.("taskA", "api");
    hooks.onTaskComplete?.("taskA", "out1", makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    // Run 2
    hooks.onTaskStart?.("taskB", "api");
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

    hooks.onTaskStart?.("analyze", "api");
    hooks.onTaskError?.("analyze", new Error("timeout"), 2);
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    const trace = traceStore.traces[0];
    expect(trace.taskTraces[0].success).toBe(false);
    expect(trace.taskTraces[0].output).toBe("timeout");
    expect(trace.taskTraces[0].retryCount).toBe(2);
  });

  // ─── #172: workflowInput threading ────────────────────────────────────────────

  it("#172: ExecutionTrace.workflowInput is populated from onWorkflowStart", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "bug-fix",
    });

    const workflowInput = { repo: "myapp", issue: 42 };
    hooks.onWorkflowStart?.(workflowInput);
    hooks.onTaskStart?.("analyze", "api");
    hooks.onTaskComplete?.("analyze", { fixed: true }, makeTaskMetrics());
    await hooks.onWorkflowComplete?.({ fixed: true }, makeMetrics());

    const trace = traceStore.traces[0];
    expect(trace.workflowInput).toEqual(workflowInput);
  });

  it("#172: ExecutionTrace.workflowInput is null when onWorkflowStart not called", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "bug-fix",
    });

    hooks.onTaskStart?.("analyze", "api");
    hooks.onTaskComplete?.("analyze", { fixed: true }, makeTaskMetrics());
    await hooks.onWorkflowComplete?.({ fixed: true }, makeMetrics());

    const trace = traceStore.traces[0];
    expect(trace.workflowInput).toBeNull();
  });

  it("#172: workflowInput resets between runs", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "bug-fix",
    });

    // Run 1 with input
    hooks.onWorkflowStart?.({ run: 1 });
    hooks.onTaskStart?.("taskA", "api");
    hooks.onTaskComplete?.("taskA", "out1", makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    // Run 2 with different input
    hooks.onWorkflowStart?.({ run: 2 });
    hooks.onTaskStart?.("taskB", "api");
    hooks.onTaskComplete?.("taskB", "out2", makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    expect(traceStore.traces[0].workflowInput).toEqual({ run: 1 });
    expect(traceStore.traces[1].workflowInput).toEqual({ run: 2 });
  });

  // ─── #173: agentRunner threading ──────────────────────────────────────────────

  it("#173: TaskTrace.agentRunner is populated from onTaskStart runner brand", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "bug-fix",
    });

    hooks.onTaskStart?.("analyze", "anthropic");
    hooks.onTaskComplete?.("analyze", { result: "ok" }, makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    const trace = traceStore.traces[0];
    expect(trace.taskTraces[0].agentRunner).toBe("anthropic");
  });

  it("#173: TaskTrace.agentRunner is empty string for function tasks (runner='')", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "bug-fix",
    });

    hooks.onTaskStart?.("transform", "");
    hooks.onTaskComplete?.("transform", { result: "ok" }, makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    const trace = traceStore.traces[0];
    expect(trace.taskTraces[0].agentRunner).toBe("");
  });

  it("#173: TaskTrace.agentRunner is correct on error path", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "bug-fix",
    });

    hooks.onTaskStart?.("analyze", "claude");
    hooks.onTaskError?.("analyze", new Error("rate limit"), 1);
    await hooks.onWorkflowComplete?.({}, makeMetrics());

    const trace = traceStore.traces[0];
    expect(trace.taskTraces[0].agentRunner).toBe("claude");
  });

  it("#173: multiple tasks get correct runner brands independently", async () => {
    const traceStore = makeTraceStore();
    const hooks = createLearningHooks({
      skillStore: makeSkillStore(),
      traceStore,
      workflowName: "multi-runner",
    });

    hooks.onWorkflowStart?.({});
    hooks.onTaskStart?.("step1", "api");
    hooks.onTaskComplete?.("step1", "out1", makeTaskMetrics());
    hooks.onTaskStart?.("step2", "anthropic");
    hooks.onTaskComplete?.("step2", "out2", makeTaskMetrics());
    await hooks.onWorkflowComplete?.({}, { ...makeMetrics(), taskCount: 2 });

    const trace = traceStore.traces[0];
    expect(trace.taskTraces).toHaveLength(2);
    expect(trace.taskTraces[0].agentRunner).toBe("api");
    expect(trace.taskTraces[1].agentRunner).toBe("anthropic");
  });

  // ─── #169: onTaskSpawnArgs / onTaskSpawnResult ──────────────────────────────

  describe("#169: spawn args/result captured in TaskTrace", () => {
    it("TaskTrace.spawnArgs is populated when onTaskSpawnArgs fires", async () => {
      const traceStore = makeTraceStore();
      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore,
        workflowName: "bug-fix",
      });

      const spawnArgs = {
        prompt: "Analyze this repo",
        taskName: "analyze",
        systemPrompt: "You MUST respond with valid JSON",
      };

      hooks.onTaskStart?.("analyze", "api");
      hooks.onTaskSpawnArgs?.("analyze", spawnArgs);
      hooks.onTaskComplete?.("analyze", { fixed: true }, makeTaskMetrics());
      await hooks.onWorkflowComplete?.({ fixed: true }, makeMetrics());

      const trace = traceStore.traces[0];
      expect(trace.taskTraces[0].spawnArgs).toEqual(spawnArgs);
    });

    it("TaskTrace.spawnResult is populated when onTaskSpawnResult fires", async () => {
      const traceStore = makeTraceStore();
      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore,
        workflowName: "bug-fix",
      });

      const spawnResult = {
        stdout: JSON.stringify({ fixed: true }),
        sessionHandle: "sess-123",
        tokensIn: 100,
        tokensOut: 50,
      };

      hooks.onTaskStart?.("analyze", "api");
      hooks.onTaskSpawnResult?.("analyze", spawnResult);
      hooks.onTaskComplete?.("analyze", { fixed: true }, makeTaskMetrics());
      await hooks.onWorkflowComplete?.({ fixed: true }, makeMetrics());

      const trace = traceStore.traces[0];
      expect(trace.taskTraces[0].spawnResult).toEqual(spawnResult);
    });

    it("TaskTrace.spawnArgs and spawnResult are both omitted when hooks never fire", async () => {
      const traceStore = makeTraceStore();
      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore,
        workflowName: "bug-fix",
      });

      // Neither spawn hook is called
      hooks.onTaskStart?.("analyze", "api");
      hooks.onTaskComplete?.("analyze", { fixed: true }, makeTaskMetrics());
      await hooks.onWorkflowComplete?.({ fixed: true }, makeMetrics());

      const trace = traceStore.traces[0];
      expect(trace.taskTraces[0].spawnArgs).toBeUndefined();
      expect(trace.taskTraces[0].spawnResult).toBeUndefined();
    });

    it("spawnArgs and spawnResult reset correctly between runs", async () => {
      const traceStore = makeTraceStore();
      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore,
        workflowName: "bug-fix",
      });

      const spawnArgs1 = {
        prompt: "Run 1 prompt",
        taskName: "taskA",
        systemPrompt: "",
      };

      // Run 1: with spawn args
      hooks.onTaskStart?.("taskA", "api");
      hooks.onTaskSpawnArgs?.("taskA", spawnArgs1);
      hooks.onTaskComplete?.("taskA", "out1", makeTaskMetrics());
      await hooks.onWorkflowComplete?.({}, makeMetrics());

      // Run 2: without spawn args
      hooks.onTaskStart?.("taskB", "api");
      // No onTaskSpawnArgs for taskB
      hooks.onTaskComplete?.("taskB", "out2", makeTaskMetrics());
      await hooks.onWorkflowComplete?.({}, makeMetrics());

      expect(traceStore.traces[0].taskTraces[0].spawnArgs).toEqual(spawnArgs1);
      expect(traceStore.traces[1].taskTraces[0].spawnArgs).toBeUndefined();
    });
  });

  // ─── #171: reflectEvery scheduler ────────────────────────────────────────────

  describe("#171: reflectEvery scheduler", () => {
    const dagStructure = { taskA: [] as readonly string[] };

    async function runWorkflow(
      hooks: ReturnType<typeof createLearningHooks>,
    ): Promise<void> {
      hooks.onTaskStart?.("taskA", "api");
      hooks.onTaskComplete?.("taskA", "out", makeTaskMetrics());
      await hooks.onWorkflowComplete?.({}, makeMetrics());
    }

    it("reflectEvery: 3 + 9 completions → runReflection fires 3 times", async () => {
      const spy = vi
        .spyOn(reflectionModule, "runReflection")
        .mockResolvedValue({
          workflowScore: 0.8,
          skillsGenerated: 0,
          skillsUpdated: 0,
          tasksReflected: [],
          taskScores: {},
        });

      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore: makeTraceStore(),
        workflowName: "test-wf",
        dagStructure,
        config: { reflectEvery: 3 },
      });

      for (let i = 0; i < 9; i++) {
        await runWorkflow(hooks);
      }
      // Allow fire-and-forget promises to settle
      await Promise.resolve();

      expect(spy).toHaveBeenCalledTimes(3);
      spy.mockRestore();
    });

    it("reflectEvery: 1 + 1 completion → runReflection fires once", async () => {
      const spy = vi
        .spyOn(reflectionModule, "runReflection")
        .mockResolvedValue({
          workflowScore: 0.9,
          skillsGenerated: 0,
          skillsUpdated: 0,
          tasksReflected: [],
          taskScores: {},
        });

      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore: makeTraceStore(),
        workflowName: "test-wf",
        dagStructure,
        config: { reflectEvery: 1 },
      });

      await runWorkflow(hooks);
      await Promise.resolve();

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("reflectEvery: undefined (default) → never fires automatically", async () => {
      const spy = vi
        .spyOn(reflectionModule, "runReflection")
        .mockResolvedValue({
          workflowScore: 0.9,
          skillsGenerated: 0,
          skillsUpdated: 0,
          tasksReflected: [],
          taskScores: {},
        });

      // No reflectEvery in config and no dagStructure → should never fire
      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore: makeTraceStore(),
        workflowName: "test-wf",
        // No dagStructure — auto-reflection disabled
      });

      await runWorkflow(hooks);
      await runWorkflow(hooks);
      await runWorkflow(hooks);
      await Promise.resolve();

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("runReflection failure does NOT crash workflow (fire-and-forget)", async () => {
      const spy = vi
        .spyOn(reflectionModule, "runReflection")
        .mockRejectedValue(new Error("LLM API down"));

      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore: makeTraceStore(),
        workflowName: "test-wf",
        dagStructure,
        config: { reflectEvery: 1 },
      });

      // onWorkflowComplete must resolve without throwing even if runReflection rejects
      await expect(runWorkflow(hooks)).resolves.toBeUndefined();
      await Promise.resolve();

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    // ─── #185: serialization (isReflecting guard) ─────────────────────────────

    it("#185: two completions while reflection is slow → only one reflection runs concurrently", async () => {
      // neverResolve keeps the first reflection in-flight for the duration of the test.
      const reflectionResult = {
        workflowScore: 0.9,
        skillsGenerated: 0,
        skillsUpdated: 0,
        tasksReflected: [] as string[],
        taskScores: {} as Record<string, number>,
      };
      const spy = vi
        .spyOn(reflectionModule, "runReflection")
        // First call: never resolves during this test (simulates slow reflection)
        .mockImplementationOnce(() => new Promise(() => {}))
        // Second call (if guard fails): instant — so the test assertion catches it
        .mockResolvedValueOnce(reflectionResult);

      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore: makeTraceStore(),
        workflowName: "test-wf",
        dagStructure,
        config: { reflectEvery: 1 },
      });

      // Completion 1 — triggers reflection; leaves it in-flight
      await runWorkflow(hooks);
      // Completion 2 — reflection 1 still in-flight → must be debounced (skipped)
      await runWorkflow(hooks);
      await Promise.resolve();

      // Only one reflection should have been launched so far
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });

    it("#185: after first reflection finishes, next eligible completion fires again", async () => {
      let resolveFirst!: () => void;
      const reflectionResult = {
        workflowScore: 0.9,
        skillsGenerated: 0,
        skillsUpdated: 0,
        tasksReflected: [] as string[],
        taskScores: {} as Record<string, number>,
      };

      const spy = vi
        .spyOn(reflectionModule, "runReflection")
        // First call: slow (controlled via resolveFirst)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = () => resolve(reflectionResult);
            }),
        )
        // Second call: instant
        .mockResolvedValueOnce(reflectionResult);

      const hooks = createLearningHooks({
        skillStore: makeSkillStore(),
        traceStore: makeTraceStore(),
        workflowName: "test-wf",
        dagStructure,
        config: { reflectEvery: 1 },
      });

      // Completion 1 — launches slow reflection
      await runWorkflow(hooks);
      expect(spy).toHaveBeenCalledTimes(1);

      // Completion 2 — reflection still in-flight → debounced
      await runWorkflow(hooks);
      expect(spy).toHaveBeenCalledTimes(1);

      // Settle the first reflection and allow microtasks to drain
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();

      // Completion 3 — isReflecting is now false → new reflection fires
      await runWorkflow(hooks);
      await Promise.resolve();
      expect(spy).toHaveBeenCalledTimes(2);

      spy.mockRestore();
    });
  });
});
