import { describe, it, assertType, expectTypeOf } from "vitest";
import { z } from "zod";
import { defineAgent, resolveAgentDef } from "../builders.js";
import type { AgentDef, BoundCtx, RunnerOf, OutputOf, SessionToken, TaskDef } from "../types.js";

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
    assertType<AgentDef<
      z.ZodObject<{ repoPath: z.ZodString }, "strip">,
      z.ZodObject<{ issues: z.ZodArray<z.ZodString>; count: z.ZodNumber }, "strip">,
      "claude"
    >>(analyzeAgent);
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
    const claudeToken: SessionToken<"claude"> = { kind: "token", name: "my-session" };

    // This should type-check fine
    assertType<TaskDef<typeof analyzeAgent>>({
      agent: analyzeAgent,
      session: claudeToken,
    });
  });

  it("SessionToken<'claude'> is NOT assignable to session field of codex agent task", () => {
    const claudeToken: SessionToken<"claude"> = { kind: "token", name: "my-session" };

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
    assertType<{ readonly analyze: { readonly output: unknown; readonly _source: string } }>({} as Ctx);
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
