import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineAgent,
  defineWorkflow,
  loop,
  registerRunner,
  resolveAgentDef,
  sessionToken,
  shareSessionWith,
  shutdownAllRunners,
  unregisterRunner,
} from "../builders.js";

describe("defineAgent", () => {
  it("returns correct structure with runner brand", () => {
    const agent = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ text }) => `Process: ${text}`,
    });

    expect(agent.runner).toBe("claude");
    expect(agent.input).toBeDefined();
    expect(agent.output).toBeDefined();
    expect(agent.prompt).toBeTypeOf("function");
  });

  it("sanitizeInput is not set in raw def (defaults handled in resolveAgentDef)", () => {
    const agent = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ text }) => `Process: ${text}`,
    });

    // Raw def doesn't set sanitizeInput — resolver handles the default
    expect(agent.sanitizeInput).toBeUndefined();
  });

  it("preserves explicit sanitizeInput: false", () => {
    const agent = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ text }) => `Process: ${text}`,
      sanitizeInput: false,
    });

    expect(agent.sanitizeInput).toBe(false);
  });

  it("throws on invalid runner name with special chars", () => {
    expect(() =>
      defineAgent({
        runner: "my runner!" as string,
        input: z.object({ text: z.string() }),
        output: z.object({ result: z.string() }),
        prompt: () => "test",
      }),
    ).toThrow(/invalid characters/);
  });

  it("throws on runner name with spaces", () => {
    expect(() =>
      defineAgent({
        runner: "my runner" as string,
        input: z.object({ text: z.string() }),
        output: z.object({ result: z.string() }),
        prompt: () => "test",
      }),
    ).toThrow(/invalid characters/);
  });

  it("warns when output is z.any()", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.any(),
      prompt: () => "test",
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ZodAny"));
    warnSpy.mockRestore();
  });

  it("warns when output is z.unknown()", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.unknown(),
      prompt: () => "test",
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ZodUnknown"));
    warnSpy.mockRestore();
  });

  it("throws on invalid mcp.server name", () => {
    expect(() =>
      defineAgent({
        runner: "claude",
        input: z.object({ text: z.string() }),
        output: z.object({ result: z.string() }),
        prompt: () => "test",
        mcps: [{ server: "my server!" }],
      }),
    ).toThrow(/invalid characters/);
  });

  it("accepts valid mcp.server name", () => {
    expect(() =>
      defineAgent({
        runner: "claude",
        input: z.object({ text: z.string() }),
        output: z.object({ result: z.string() }),
        prompt: () => "test",
        mcps: [{ server: "my-mcp-server.v2" }],
      }),
    ).not.toThrow();
  });
});

describe("resolveAgentDef — mcps migration shim", () => {
  it("migrates deprecated mcps field to mcp.servers", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const def = defineAgent({
      runner: "claude",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "x",
      mcps: [{ server: "filesystem", args: ["/tmp"], autoStart: true }],
    });
    const resolved = resolveAgentDef(def);
    expect(resolved.mcp?.servers).toHaveLength(1);
    expect(resolved.mcp?.servers?.[0]?.name).toBe("filesystem");
    expect(resolved.mcp?.servers?.[0]?.args).toEqual(["/tmp"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("mcps"));
    warnSpy.mockRestore();
  });

  it("new mcp.servers wins over mcps when both set", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const def = defineAgent({
      runner: "claude",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "x",
      mcp: { servers: [{ name: "new", command: "npx" }] },
      mcps: [{ server: "old" }],
    });
    const resolved = resolveAgentDef(def);
    expect(resolved.mcp?.servers?.[0]?.name).toBe("new");
    warnSpy.mockRestore();
  });
});

describe("resolveAgentDef", () => {
  it("fills all defaults", () => {
    const agent = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ text }) => `Process: ${text}`,
    });

    const resolved = resolveAgentDef(agent);

    expect(resolved.sanitizeInput).toBe(true);
    expect(resolved.timeoutMs).toBe(300_000);
    expect(resolved.maxOutputBytes).toBe(1_048_576);
    expect(resolved.retry.max).toBe(3);
    expect(resolved.retry.backoff).toBe("exponential");
    expect(resolved.retry.on).toContain("subprocess_error");
    expect(resolved.retry.on).toContain("output_validation_error");
    expect(resolved.retry.timeoutMs).toBe(300_000);
  });

  it("preserves explicit sanitizeInput: false", () => {
    const agent = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: () => "test",
      sanitizeInput: false,
    });

    const resolved = resolveAgentDef(agent);
    expect(resolved.sanitizeInput).toBe(false);
  });

  it("preserves explicit sanitizeInput: true", () => {
    const agent = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: () => "test",
      sanitizeInput: true,
    });

    const resolved = resolveAgentDef(agent);
    expect(resolved.sanitizeInput).toBe(true);
  });

  it("merges partial retry config with defaults", () => {
    const agent = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: () => "test",
      retry: { max: 5 },
    });

    const resolved = resolveAgentDef(agent);
    expect(resolved.retry.max).toBe(5);
    expect(resolved.retry.backoff).toBe("exponential");
    expect(resolved.retry.timeoutMs).toBe(300_000);
  });

  it("uses explicit timeoutMs", () => {
    const agent = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: () => "test",
      timeoutMs: 60_000,
    });

    const resolved = resolveAgentDef(agent);
    expect(resolved.timeoutMs).toBe(60_000);
  });

  it("uses explicit maxOutputBytes", () => {
    const agent = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: () => "test",
      maxOutputBytes: 512_000,
    });

    const resolved = resolveAgentDef(agent);
    expect(resolved.maxOutputBytes).toBe(512_000);
  });
});

describe("sessionToken", () => {
  it("creates token with kind='token'", () => {
    const token = sessionToken("my-session", "claude");
    expect(token.kind).toBe("token");
    expect(token.name).toBe("my-session");
  });

  it("throws on invalid runner name", () => {
    expect(() =>
      sessionToken("my-session", "invalid runner!" as string),
    ).toThrow(/invalid characters/);
  });
});

describe("shareSessionWith", () => {
  it("creates ref with kind='share' and correct taskName", () => {
    const ref = shareSessionWith<Record<string, never>, never>(
      "analyze" as never,
    );
    expect(ref.kind).toBe("share");
    expect(ref.taskName).toBe("analyze");
  });

  it("creates correct taskName for different task names", () => {
    const ref = shareSessionWith<Record<string, never>, never>(
      "summarize" as never,
    );
    expect(ref.taskName).toBe("summarize");
  });
});

describe("defineWorkflow", () => {
  it("returns config unchanged (identity)", () => {
    const analyzeAgent = defineAgent({
      runner: "claude",
      input: z.object({ repoPath: z.string() }),
      output: z.object({ issues: z.array(z.string()) }),
      prompt: ({ repoPath }) => `Analyze ${repoPath}`,
    });

    const config = {
      name: "test-workflow",
      tasks: {
        analyze: {
          agent: analyzeAgent,
          input: { repoPath: "./src" },
        },
      },
    } as const;

    const workflow = defineWorkflow(config);
    expect(workflow).toBe(config);
    expect(workflow.name).toBe("test-workflow");
    expect(workflow.tasks.analyze).toBeDefined();
  });
});

describe("loop", () => {
  it("adds kind='loop' to config", () => {
    const evalAgent = defineAgent({
      runner: "claude",
      input: z.object({ count: z.number() }),
      output: z.object({ satisfied: z.boolean() }),
      prompt: ({ count }) => `Eval count: ${count}`,
    });

    const loopDef = loop({
      dependsOn: [],
      max: 5,
      until: () => false,
      context: "persistent",
      tasks: {
        eval: { agent: evalAgent, input: { count: 0 } },
      },
    });

    expect(loopDef.kind).toBe("loop");
    expect(loopDef.max).toBe(5);
    expect(loopDef.context).toBe("persistent");
  });
});

describe("shutdownAllRunners", () => {
  const RUNNER_A = "__test_shutdown_a__";
  const RUNNER_B = "__test_shutdown_b__";

  afterEach(() => {
    unregisterRunner(RUNNER_A);
    unregisterRunner(RUNNER_B);
  });

  it("calls shutdown() on all registered runners that implement it", async () => {
    const shutdownA = vi.fn().mockResolvedValue(undefined);
    const shutdownB = vi.fn().mockResolvedValue(undefined);

    registerRunner(RUNNER_A, {
      validate: async () => ({ ok: true }),
      spawn: async () => ({
        stdout: "{}",
        sessionHandle: "",
        tokensIn: 0,
        tokensOut: 0,
      }),
      shutdown: shutdownA,
    });
    registerRunner(RUNNER_B, {
      validate: async () => ({ ok: true }),
      spawn: async () => ({
        stdout: "{}",
        sessionHandle: "",
        tokensIn: 0,
        tokensOut: 0,
      }),
      shutdown: shutdownB,
    });

    await shutdownAllRunners();

    expect(shutdownA).toHaveBeenCalledOnce();
    expect(shutdownB).toHaveBeenCalledOnce();
  });

  it("does not throw for runners without shutdown()", async () => {
    registerRunner(RUNNER_A, {
      validate: async () => ({ ok: true }),
      spawn: async () => ({
        stdout: "{}",
        sessionHandle: "",
        tokensIn: 0,
        tokensOut: 0,
      }),
      // no shutdown
    });

    await expect(shutdownAllRunners()).resolves.toBeUndefined();
  });

  it("swallows individual runner shutdown errors (allSettled)", async () => {
    const shutdownA = vi.fn().mockRejectedValue(new Error("cleanup failure"));
    const shutdownB = vi.fn().mockResolvedValue(undefined);

    registerRunner(RUNNER_A, {
      validate: async () => ({ ok: true }),
      spawn: async () => ({
        stdout: "{}",
        sessionHandle: "",
        tokensIn: 0,
        tokensOut: 0,
      }),
      shutdown: shutdownA,
    });
    registerRunner(RUNNER_B, {
      validate: async () => ({ ok: true }),
      spawn: async () => ({
        stdout: "{}",
        sessionHandle: "",
        tokensIn: 0,
        tokensOut: 0,
      }),
      shutdown: shutdownB,
    });

    // Must not throw even though runner A's shutdown rejects
    await expect(shutdownAllRunners()).resolves.toBeUndefined();
    // Runner B was still called despite runner A failing
    expect(shutdownB).toHaveBeenCalledOnce();
  });

  it("resolves immediately when no runners are registered", async () => {
    await expect(shutdownAllRunners()).resolves.toBeUndefined();
  });

  it("#138: swallows sync throw from shutdown() — does not propagate", async () => {
    // If shutdown() throws synchronously (not returning a rejected promise),
    // the async wrapper converts the sync throw to a rejected promise so
    // Promise.allSettled can catch it. The overall call must still resolve.
    const syncThrowShutdown = vi.fn(() => {
      throw new Error("sync shutdown crash");
    });

    registerRunner(RUNNER_A, {
      validate: async () => ({ ok: true }),
      spawn: async () => ({
        stdout: "{}",
        sessionHandle: "",
        tokensIn: 0,
        tokensOut: 0,
      }),
      shutdown: syncThrowShutdown,
    });

    await expect(shutdownAllRunners()).resolves.toBeUndefined();
    expect(syncThrowShutdown).toHaveBeenCalledOnce();
  });
});
