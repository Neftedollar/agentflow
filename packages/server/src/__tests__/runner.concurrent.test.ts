import {
  defineAgent,
  defineWorkflow,
  registerRunner,
  unregisterRunner,
} from "@ageflow/core";
import type { Runner as AgentRunner, WorkflowEvent } from "@ageflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRunner } from "../runner.js";

// ---------------------------------------------------------------------------
// Shared schema
// ---------------------------------------------------------------------------

const outputSchema = z.object({ tag: z.string() });

// ---------------------------------------------------------------------------
// Test 1: two concurrent runs complete independently
// ---------------------------------------------------------------------------

describe("concurrent fire(): two runs complete independently", () => {
  // Use two distinct runners so each workflow's output is deterministically
  // tagged — no shared mutable state between the two runs.
  const RUNNER_A = "concurrent-basic-A";
  const RUNNER_B = "concurrent-basic-B";

  const runnerA: AgentRunner = {
    validate: async () => ({ ok: true }),
    spawn: async () => ({
      stdout: JSON.stringify({ tag: "A" }),
      sessionHandle: "s",
      tokensIn: 1,
      tokensOut: 1,
    }),
  };
  const runnerB: AgentRunner = {
    validate: async () => ({ ok: true }),
    spawn: async () => ({
      stdout: JSON.stringify({ tag: "B" }),
      sessionHandle: "s",
      tokensIn: 1,
      tokensOut: 1,
    }),
  };

  const agentA = defineAgent({
    runner: RUNNER_A,
    input: z.object({}),
    output: outputSchema,
    prompt: () => "wf-A",
  });
  const agentB = defineAgent({
    runner: RUNNER_B,
    input: z.object({}),
    output: outputSchema,
    prompt: () => "wf-B",
  });

  const wfA = defineWorkflow({
    name: "concurrent-wf-A",
    tasks: { t: { agent: agentA, input: {} } },
  });
  const wfB = defineWorkflow({
    name: "concurrent-wf-B",
    tasks: { t: { agent: agentB, input: {} } },
  });

  beforeEach(() => {
    registerRunner(RUNNER_A, runnerA);
    registerRunner(RUNNER_B, runnerB);
  });
  afterEach(() => {
    unregisterRunner(RUNNER_A);
    unregisterRunner(RUNNER_B);
  });

  it("both runs reach state=done with outputs reflecting their own inputs", async () => {
    const runner = createRunner();

    const doneA = new Promise<{ runId: string }>((resolve) => {
      const h = runner.fire(wfA, {}, { onComplete: () => resolve(h) });
    });
    const doneB = new Promise<{ runId: string }>((resolve) => {
      const h = runner.fire(wfB, {}, { onComplete: () => resolve(h) });
    });

    const [handleA, handleB] = await Promise.all([doneA, doneB]);

    const snapA = runner.get(handleA.runId);
    const snapB = runner.get(handleB.runId);

    expect(snapA?.state).toBe("done");
    expect(snapB?.state).toBe("done");

    // Each run's output must carry its own tag, not the other run's.
    expect(
      (snapA as { result?: { outputs: Record<string, unknown> } })?.result
        ?.outputs.t,
    ).toMatchObject({ tag: "A" });
    expect(
      (snapB as { result?: { outputs: Record<string, unknown> } })?.result
        ?.outputs.t,
    ).toMatchObject({ tag: "B" });

    // Both runIds exist in the registry.
    const allIds = runner.list().map((h) => h.runId);
    expect(allIds).toContain(handleA.runId);
    expect(allIds).toContain(handleB.runId);

    await runner.close();
  });
});

// ---------------------------------------------------------------------------
// Test 2: slow + fast concurrent runs — fast finishes first, slow completes
// ---------------------------------------------------------------------------

describe("concurrent fire(): slow+fast — fast finishes first, slow completes correctly", () => {
  const SLOW_RUNNER = "concurrent-slow";
  const FAST_RUNNER = "concurrent-fast";

  const slowRunner: AgentRunner = {
    validate: async () => ({ ok: true }),
    spawn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        stdout: JSON.stringify({ tag: "slow" }),
        sessionHandle: "s",
        tokensIn: 1,
        tokensOut: 1,
      };
    },
  };

  const fastRunner: AgentRunner = {
    validate: async () => ({ ok: true }),
    spawn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        stdout: JSON.stringify({ tag: "fast" }),
        sessionHandle: "s",
        tokensIn: 1,
        tokensOut: 1,
      };
    },
  };

  const agentSlow = defineAgent({
    runner: SLOW_RUNNER,
    input: z.object({}),
    output: z.object({ tag: z.string() }),
    prompt: () => "slow",
  });
  const agentFast = defineAgent({
    runner: FAST_RUNNER,
    input: z.object({}),
    output: z.object({ tag: z.string() }),
    prompt: () => "fast",
  });

  const wfSlow = defineWorkflow({
    name: "slow-wf",
    tasks: { t: { agent: agentSlow, input: {} } },
  });
  const wfFast = defineWorkflow({
    name: "fast-wf",
    tasks: { t: { agent: agentFast, input: {} } },
  });

  beforeEach(() => {
    registerRunner(SLOW_RUNNER, slowRunner);
    registerRunner(FAST_RUNNER, fastRunner);
  });
  afterEach(() => {
    unregisterRunner(SLOW_RUNNER);
    unregisterRunner(FAST_RUNNER);
  });

  it("fast run is done while slow is still running; slow eventually completes", async () => {
    const runner = createRunner();

    // Fire slow first, then fast.
    let slowRunId!: string;
    const slowDone = new Promise<void>((resolve) => {
      const h = runner.fire(wfSlow, {}, { onComplete: () => resolve() });
      slowRunId = h.runId;
    });

    let fastRunId!: string;
    const fastDone = new Promise<void>((resolve) => {
      const h = runner.fire(wfFast, {}, { onComplete: () => resolve() });
      fastRunId = h.runId;
    });

    // Wait for the fast run to finish first.
    await fastDone;

    // At this point, fast should be done and slow should still be running.
    expect(runner.get(fastRunId)?.state).toBe("done");
    expect(runner.get(slowRunId)?.state).toBe("running");

    // Now wait for slow to complete — must not be interrupted by fast's completion.
    await slowDone;
    expect(runner.get(slowRunId)?.state).toBe("done");
    expect(
      (
        runner.get(slowRunId) as {
          result?: { outputs: Record<string, unknown> };
        }
      )?.result?.outputs.t,
    ).toMatchObject({ tag: "slow" });

    await runner.close();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Test 3: event isolation — onEvent for wfA never receives wfB's events
// ---------------------------------------------------------------------------

describe("concurrent fire(): event isolation between workflows", () => {
  const RUNNER_NAME = "concurrent-isolation";

  const instantRunner: AgentRunner = {
    validate: async () => ({ ok: true }),
    spawn: async () => ({
      stdout: JSON.stringify({ ok: true }),
      sessionHandle: "s",
      tokensIn: 1,
      tokensOut: 1,
    }),
  };

  const agentA = defineAgent({
    runner: RUNNER_NAME,
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    prompt: () => "p",
  });
  const agentB = defineAgent({
    runner: RUNNER_NAME,
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    prompt: () => "p",
  });

  const wfA = defineWorkflow({
    name: "isolation-wf-A",
    tasks: { t: { agent: agentA, input: {} } },
  });
  const wfB = defineWorkflow({
    name: "isolation-wf-B",
    tasks: { t: { agent: agentB, input: {} } },
  });

  beforeEach(() => registerRunner(RUNNER_NAME, instantRunner));
  afterEach(() => unregisterRunner(RUNNER_NAME));

  it("onEvent for wfA receives only events tagged with wfA's runId and name", async () => {
    const runner = createRunner();

    const eventsA: WorkflowEvent[] = [];
    const eventsB: WorkflowEvent[] = [];

    let runIdA!: string;
    let runIdB!: string;

    const doneA = new Promise<void>((resolve) => {
      const h = runner.fire(
        wfA,
        {},
        {
          onEvent: (ev) => eventsA.push(ev),
          onComplete: () => resolve(),
        },
      );
      runIdA = h.runId;
    });

    const doneB = new Promise<void>((resolve) => {
      const h = runner.fire(
        wfB,
        {},
        {
          onEvent: (ev) => eventsB.push(ev),
          onComplete: () => resolve(),
        },
      );
      runIdB = h.runId;
    });

    await Promise.all([doneA, doneB]);

    // Every event received by wfA's callback must carry wfA's runId — never wfB's.
    for (const ev of eventsA) {
      expect(ev.runId).toBe(runIdA);
      expect(ev.runId).not.toBe(runIdB);
    }

    // Every event received by wfB's callback must carry wfB's runId — never wfA's.
    for (const ev of eventsB) {
      expect(ev.runId).toBe(runIdB);
      expect(ev.runId).not.toBe(runIdA);
    }

    // Sanity: each callback received at least one event.
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);

    await runner.close();
  });
});
