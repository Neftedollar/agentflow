import { assertType, describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  defineAgent,
  defineFunction,
  defineWorkflowFactory,
  resolveAgentDef,
} from "../builders.js";
import type {
  AgentDef,
  BoundCtx,
  CtxFor,
  FunctionTaskDef,
  InputOf,
  OutputOf,
  RunnerOf,
  SessionToken,
  TaskDef,
  TasksMap,
} from "../types.js";

// ─── Test agents ──────────────────────────────────────────────────────────────

const analyzeAgent = defineAgent({
  runner: "claude",
  model: "claude-opus-4-6",
  input: z.object({ repoPath: z.string() }),
  output: z.object({ issues: z.array(z.string()), count: z.number() }),
  prompt: ({ repoPath }) => `Analyze ${repoPath} for issues`,
});

const codexAgent = defineAgent({
  runner: "codex",
  input: z.object({ code: z.string() }),
  output: z.object({ result: z.string() }),
  prompt: ({ code }) => `Review: ${code}`,
});

// ─── Type tests ───────────────────────────────────────────────────────────────

describe("defineAgent type inference", () => {
  it("runner is literal 'claude', not string", () => {
    // Should be AgentDef<..., ..., "claude"> not AgentDef<..., ..., string>
    expectTypeOf(analyzeAgent.runner).toEqualTypeOf<"claude">();
  });

  it("AgentDef is typed correctly", () => {
    assertType<
      AgentDef<
        z.ZodObject<{ repoPath: z.ZodString }, "strip">,
        z.ZodObject<
          { issues: z.ZodArray<z.ZodString>; count: z.ZodNumber },
          "strip"
        >,
        "claude"
      >
    >(analyzeAgent);
  });
});

describe("RunnerOf type utility", () => {
  it("RunnerOf<analyzeAgent> = 'claude'", () => {
    expectTypeOf<RunnerOf<typeof analyzeAgent>>().toEqualTypeOf<"claude">();
  });

  it("RunnerOf<codexAgent> = 'codex'", () => {
    expectTypeOf<RunnerOf<typeof codexAgent>>().toEqualTypeOf<"codex">();
  });
});

describe("OutputOf type utility", () => {
  it("OutputOf matches zod schema inferred type", () => {
    expectTypeOf<OutputOf<typeof analyzeAgent>>().toEqualTypeOf<{
      issues: string[];
      count: number;
    }>();
  });
});

describe("resolveAgentDef types", () => {
  it("sanitizeInput is typed boolean (not boolean | undefined)", () => {
    const resolved = resolveAgentDef(analyzeAgent);
    expectTypeOf(resolved.sanitizeInput).toEqualTypeOf<boolean>();
  });

  it("timeoutMs is typed number (not number | undefined)", () => {
    const resolved = resolveAgentDef(analyzeAgent);
    expectTypeOf(resolved.timeoutMs).toEqualTypeOf<number>();
  });

  it("maxOutputBytes is typed number (not number | undefined)", () => {
    const resolved = resolveAgentDef(analyzeAgent);
    expectTypeOf(resolved.maxOutputBytes).toEqualTypeOf<number>();
  });
});

describe("SessionToken phantom brand type safety", () => {
  it("SessionToken<'claude'> is assignable to session field of claude agent task", () => {
    const claudeToken: SessionToken<"claude"> = {
      kind: "token",
      name: "my-session",
    };

    // This should type-check fine
    assertType<TaskDef<typeof analyzeAgent>>({
      agent: analyzeAgent,
      session: claudeToken,
    });
  });

  it("SessionToken<'claude'> is NOT assignable to session field of codex agent task", () => {
    const claudeToken: SessionToken<"claude"> = {
      kind: "token",
      name: "my-session",
    };

    // Build the task object — session field should be a type error (cross-provider)
    const badTask: TaskDef<typeof codexAgent> = {
      agent: codexAgent,
      // @ts-expect-error - cross-provider session assignment should be a type error
      session: claudeToken,
    };
    // Suppress unused variable warning
    void badTask;
  });
});

describe("BoundCtx — dependsOn key enforcement", () => {
  it("BoundCtx restricts ctx to declared keys only", () => {
    // With literal deps D = ["analyze"], only "analyze" is valid
    type Ctx = BoundCtx<readonly ["analyze"]>;
    assertType<{
      readonly analyze: { readonly output: unknown; readonly _source: string };
    }>({} as Ctx);
  });

  it("accessing an undeclared dep key is a type error", () => {
    type Ctx = BoundCtx<readonly ["analyze"]>;
    const ctx = {} as Ctx;

    // @ts-expect-error — "fix" is not in dependsOn, should be a type error
    void ctx.fix;
  });

  it("declared dep key compiles fine", () => {
    type Ctx = BoundCtx<readonly ["analyze", "fix"]>;
    const ctx = {} as Ctx;
    void ctx.analyze.output;
    void ctx.fix.output;
  });

  it("TaskDef input callback ctx is restricted to dependsOn keys", () => {
    // Constructing a TaskDef with as-const dependsOn — ctx should be typed
    const taskWithTypedCtx: TaskDef<typeof analyzeAgent, readonly ["prior"]> = {
      agent: analyzeAgent,
      dependsOn: ["prior"] as const,
      input: (ctx) => {
        void ctx.prior.output; // ✓ "prior" is in dependsOn
        // @ts-expect-error — "other" is not in dependsOn
        void ctx.other;
        return { repoPath: "./src" };
      },
    };
    void taskWithTypedCtx;
  });
});

// ─── defineFunction type tests ────────────────────────────────────────────────

const snapshotStep = defineFunction({
  input: z.object({ userId: z.string() }),
  output: z.object({ orders: z.array(z.string()), total: z.number() }),
  execute: async (input) => ({
    orders: [`order-${input.userId}`],
    total: 42,
  }),
});

describe("defineFunction type inference", () => {
  it("InputOf<FunctionDef> resolves to inferred Zod input type", () => {
    expectTypeOf<InputOf<typeof snapshotStep>>().toEqualTypeOf<{
      userId: string;
    }>();
  });

  it("OutputOf<FunctionDef> resolves to inferred Zod output type", () => {
    expectTypeOf<OutputOf<typeof snapshotStep>>().toEqualTypeOf<{
      orders: string[];
      total: number;
    }>();
  });

  it("execute signature takes only input (no ctx arg)", () => {
    // The execute function should only accept the typed input, not a second ctx arg
    expectTypeOf(snapshotStep.execute).parameters.toEqualTypeOf<
      [{ userId: string }]
    >();
  });
});

describe("CtxFor with fn task dep", () => {
  it("CtxFor resolves fn task output from outputSchema", () => {
    type Tasks = {
      snapshot: FunctionTaskDef<typeof snapshotStep, readonly []>;
      process: TaskDef<typeof analyzeAgent, readonly ["snapshot"]>;
    };

    type Ctx = CtxFor<Tasks, "process">;
    assertType<{
      readonly snapshot: {
        readonly output: { orders: string[]; total: number };
        readonly _source: "function";
      };
    }>({} as Ctx);
  });
});

// ─── defineWorkflowFactory task-key inference (#198) ─────────────────────────

const factoryAgentA = defineAgent({
  runner: "claude",
  input: z.object({}),
  output: z.object({ x: z.string() }),
  prompt: () => "a",
});

const factoryAgentB = defineAgent({
  runner: "claude",
  input: z.object({}),
  output: z.object({ y: z.number() }),
  prompt: () => "b",
});

describe("defineWorkflowFactory preserves task-key inference", () => {
  it("task keys are 'a' | 'b', not string (TasksMap-wide)", () => {
    const f = defineWorkflowFactory((_input: { name: string }) => ({
      name: "x",
      tasks: {
        a: { agent: factoryAgentA, input: () => ({}) },
        b: {
          agent: factoryAgentB,
          dependsOn: ["a"] as const,
          input: () => ({}),
        },
      },
    }));

    const wf = f({ name: "test" });

    // keyof Tasks must be the literal union "a" | "b", not the wide string type
    expectTypeOf<keyof typeof wf.tasks>().toEqualTypeOf<"a" | "b">();
  });

  it("CtxFor narrows correctly on a factory-produced WorkflowDef", () => {
    const f = defineWorkflowFactory((_input: { name: string }) => ({
      name: "x",
      tasks: {
        a: { agent: factoryAgentA, input: () => ({}) },
        b: {
          agent: factoryAgentB,
          dependsOn: ["a"] as const,
          input: () => ({}),
        },
      },
    }));

    const wf = f({ name: "test" });
    type Tasks = typeof wf.tasks;

    // CtxFor<Tasks, "b"> should have key "a" with output { x: string }, not the
    // wide TasksMap shape where output is unknown for all string keys
    type Ctx = CtxFor<Tasks, "b">;
    assertType<{
      readonly a: { readonly output: { x: string }; readonly _source: "agent" };
    }>({} as Ctx);
  });
});
