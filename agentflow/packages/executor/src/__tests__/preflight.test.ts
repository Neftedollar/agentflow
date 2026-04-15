import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineAgent, defineWorkflow, sessionToken, shareSessionWith } from "@agentflow/core";
import { runPreflight } from "../preflight.js";
import type { WhichFn } from "../preflight.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function alwaysFoundWhich(_runnerName: string): boolean {
  return true;
}

function neverFoundWhich(_runnerName: string): boolean {
  return false;
}

function foundOnlyWhich(...runners: string[]): WhichFn {
  return (name: string) => runners.includes(name);
}

const claudeAgent = defineAgent({
  runner: "claude",
  input: z.object({ text: z.string() }),
  output: z.object({ result: z.string() }),
  prompt: ({ text }) => `Analyze: ${text}`,
});

const codexAgent = defineAgent({
  runner: "codex",
  input: z.object({ text: z.string() }),
  output: z.object({ result: z.string() }),
  prompt: ({ text }) => `Process: ${text}`,
});

// ─── validateRunners ──────────────────────────────────────────────────────────

describe("runPreflight — runner validation", () => {
  it("returns no errors when all runners are found", async () => {
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        analyze: { agent: claudeAgent, input: { text: "hello" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    expect(result.errors).toEqual([]);
  });

  it("returns error when runner is missing from PATH", async () => {
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        analyze: { agent: claudeAgent, input: { text: "hello" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: neverFoundWhich });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("claude");
    expect(result.errors[0]).toContain("not found on PATH");
  });

  it("includes install hint for known runners", async () => {
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        analyze: { agent: claudeAgent, input: { text: "hello" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: neverFoundWhich });
    expect(result.errors[0]).toContain("Install with:");
  });

  it("reports each missing runner once", async () => {
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        t1: { agent: claudeAgent, input: { text: "a" } },
        t2: { agent: claudeAgent, input: { text: "b" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: neverFoundWhich });
    // Should have exactly one error for 'claude', not two
    const claudeErrors = result.errors.filter((e) => e.includes("claude"));
    expect(claudeErrors).toHaveLength(1);
  });

  it("reports errors for multiple distinct missing runners", async () => {
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        t1: { agent: claudeAgent, input: { text: "a" } },
        t2: { agent: codexAgent, input: { text: "b" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: neverFoundWhich });
    expect(result.errors.some((e) => e.includes("claude"))).toBe(true);
    expect(result.errors.some((e) => e.includes("codex"))).toBe(true);
  });

  it("no runner errors when runner is found", async () => {
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        t1: { agent: claudeAgent, input: { text: "a" } },
        t2: { agent: codexAgent, input: { text: "b" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: foundOnlyWhich("claude", "codex") });
    const runnerErrors = result.errors.filter(
      (e) => e.includes("not found on PATH"),
    );
    expect(runnerErrors).toHaveLength(0);
  });
});

// ─── validateDAG ──────────────────────────────────────────────────────────────

describe("runPreflight — DAG validation", () => {
  it("returns no errors for a valid DAG", async () => {
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        a: { agent: claudeAgent, input: { text: "a" } },
        b: { agent: claudeAgent, dependsOn: ["a"] as const, input: { text: "b" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const dagErrors = result.errors.filter(
      (e) => e.includes("DAG") || e.includes("cycle") || e.includes("depends"),
    );
    expect(dagErrors).toHaveLength(0);
  });

  it("detects cyclic dependencies", async () => {
    // We need to bypass TypeScript type safety to construct a cycle
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        // biome-ignore lint/suspicious/noExplicitAny: intentional cycle for testing
        a: { agent: claudeAgent, dependsOn: ["b"] as any, input: { text: "a" } },
        // biome-ignore lint/suspicious/noExplicitAny: intentional cycle for testing
        b: { agent: claudeAgent, dependsOn: ["a"] as any, input: { text: "b" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const cycleErrors = result.errors.filter((e) => e.includes("cycle") || e.includes("DAG cycle"));
    expect(cycleErrors.length).toBeGreaterThan(0);
  });

  it("detects unresolved dependencies", async () => {
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        // biome-ignore lint/suspicious/noExplicitAny: intentional unresolved dep for testing
        a: { agent: claudeAgent, dependsOn: ["nonexistent"] as any, input: { text: "a" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const depErrors = result.errors.filter(
      (e) => e.includes("nonexistent") || e.includes("DAG"),
    );
    expect(depErrors.length).toBeGreaterThan(0);
  });
});

// ─── validateSessionRefs ───────────────────────────────────────────────────────

describe("runPreflight — session ref validation", () => {
  it("returns no errors for valid session refs", async () => {
    const sess = sessionToken("shared", "claude");
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        a: { agent: claudeAgent, session: sess, input: { text: "a" } },
        b: { agent: claudeAgent, session: shareSessionWith<{ a: typeof claudeAgent extends never ? never : { agent: typeof claudeAgent; input: { text: string } } }, "a">("a"), input: { text: "b" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const sessionErrors = result.errors.filter(
      (e) => e.includes("Session") || e.includes("session"),
    );
    expect(sessionErrors).toHaveLength(0);
  });

  it("detects session cycle errors", async () => {
    // Create a session cycle: a shares with b, b shares with a
    // biome-ignore lint/suspicious/noExplicitAny: intentional session cycle for testing
    const cycleRef = { kind: "share" as const, taskName: "b" } as any;
    // biome-ignore lint/suspicious/noExplicitAny: intentional session cycle for testing
    const cycleRef2 = { kind: "share" as const, taskName: "a" } as any;

    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        a: { agent: claudeAgent, session: cycleRef, input: { text: "a" } },
        b: { agent: claudeAgent, session: cycleRef2, input: { text: "b" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const sessionErrors = result.errors.filter(
      (e) => e.includes("cycle") || e.includes("Session"),
    );
    expect(sessionErrors.length).toBeGreaterThan(0);
  });

  it("detects unresolved session ref errors", async () => {
    // Task a shares session with nonexistent task
    // biome-ignore lint/suspicious/noExplicitAny: intentional unresolved session ref
    const badRef = { kind: "share" as const, taskName: "nonexistent" } as any;

    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        a: { agent: claudeAgent, session: badRef, input: { text: "a" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const sessionErrors = result.errors.filter(
      (e) => e.includes("session") || e.includes("Session"),
    );
    expect(sessionErrors.length).toBeGreaterThan(0);
  });
});

// ─── Cross-provider session warning ───────────────────────────────────────────

describe("runPreflight — cross-provider session warning", () => {
  it("warns when a session token is shared between different runners", async () => {
    const sess = sessionToken("shared-ctx", "claude");

    // Force codex agent to use the same session token (bypassing phantom brand at runtime)
    // biome-ignore lint/suspicious/noExplicitAny: intentional cross-provider for testing
    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        a: { agent: claudeAgent, session: sess, input: { text: "a" } },
        // biome-ignore lint/suspicious/noExplicitAny: intentional cross-provider
        b: { agent: codexAgent, session: sess as any, input: { text: "b" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const crossProviderWarnings = result.warnings.filter(
      (w) =>
        w.includes("shared between different runners") ||
        w.includes("context will not carry over"),
    );
    expect(crossProviderWarnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("shared-ctx");
  });

  it("does NOT warn when a session is shared within the same runner", async () => {
    const sess = sessionToken("claude-session", "claude");

    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        a: { agent: claudeAgent, session: sess, input: { text: "a" } },
        b: { agent: claudeAgent, session: sess, input: { text: "b" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const crossProviderWarnings = result.warnings.filter(
      (w) => w.includes("shared between different runners"),
    );
    expect(crossProviderWarnings).toHaveLength(0);
  });
});

// ─── Valid workflow — no errors or warnings ────────────────────────────────────

describe("runPreflight — valid workflow", () => {
  it("returns empty errors and warnings for a clean workflow", async () => {
    const workflow = defineWorkflow({
      name: "clean-workflow",
      tasks: {
        step1: { agent: claudeAgent, input: { text: "hello" } },
        step2: {
          agent: claudeAgent,
          dependsOn: ["step1"] as const,
          input: { text: "world" },
        },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ─── validateEnvVars ──────────────────────────────────────────────────────────

describe("runPreflight — env var warnings", () => {
  it("warns about missing env vars declared in agent.env.pass", async () => {
    const agentWithEnv = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ text }) => `Analyze: ${text}`,
      env: { pass: ["DEFINITELY_NOT_SET_XYZ_12345"] },
    });

    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        t: { agent: agentWithEnv, input: { text: "hello" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const envWarnings = result.warnings.filter((w) =>
      w.includes("DEFINITELY_NOT_SET_XYZ_12345"),
    );
    expect(envWarnings.length).toBeGreaterThan(0);
    // Should be a warning, not an error
    const envErrors = result.errors.filter((e) =>
      e.includes("DEFINITELY_NOT_SET_XYZ_12345"),
    );
    expect(envErrors).toHaveLength(0);
  });
});

// ─── validateStaticArgs ───────────────────────────────────────────────────────

describe("runPreflight — static arg validation", () => {
  it("returns error for invalid runner identifier (bypassed builder via cast)", async () => {
    // defineAgent validates at construction; craft a raw TasksMap to test preflight's check
    const badTask = {
      agent: {
        runner: "bad;runner",
        input: claudeAgent.input,
        output: claudeAgent.output,
        prompt: claudeAgent.prompt,
      },
      input: { text: "test" },
    };

    const workflow = {
      name: "test",
      // biome-ignore lint/suspicious/noExplicitAny: intentional bad-actor cast for test
      tasks: { t: badTask as any },
    };

    // biome-ignore lint/suspicious/noExplicitAny: intentional bad-actor cast for test
    const result = await runPreflight(workflow as any, { whichFn: alwaysFoundWhich });
    const staticErrors = result.errors.filter((e) => e.includes("bad;runner"));
    expect(staticErrors.length).toBeGreaterThan(0);
  });

  it("returns error for invalid env var name", async () => {
    const agentWithBadEnv = defineAgent({
      runner: "claude",
      input: z.object({ text: z.string() }),
      output: z.object({ result: z.string() }),
      prompt: ({ text }) => `Analyze: ${text}`,
      env: { pass: ["lower_case_var"] }, // env vars must match /^[A-Z_][A-Z0-9_]*$/
    });

    const workflow = defineWorkflow({
      name: "test",
      tasks: {
        t: { agent: agentWithBadEnv, input: { text: "hello" } },
      },
    });

    const result = await runPreflight(workflow, { whichFn: alwaysFoundWhich });
    const staticErrors = result.errors.filter((e) => e.includes("lower_case_var"));
    expect(staticErrors.length).toBeGreaterThan(0);
  });
});
