/**
 * sse.test.ts — Harness test driving the server-embed runner.
 *
 * Replaces the "api" runner with a stub so no real API calls are made.
 * Verifies that createRunner().stream() correctly streams events and
 * pauses at the HITL checkpoint until onCheckpoint resolves.
 */

import { registerRunner, unregisterRunner } from "@ageflow/core";
import type { Runner as AgentRunner } from "@ageflow/core";
import { createRunner } from "@ageflow/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { triageWorkflow } from "../workflow.js";

// Stub runner — returns a valid classification without hitting any API.
const stub: AgentRunner = {
  validate: async () => ({ ok: true }),
  spawn: async () => ({
    stdout: JSON.stringify({ urgent: true, summary: "Server is on fire" }),
    sessionHandle: "stub",
    tokensIn: 5,
    tokensOut: 10,
  }),
};

beforeEach(() => registerRunner("api", stub));
afterEach(() => unregisterRunner("api"));

describe("server-embed demo", () => {
  it("streams events and supports resume-true via runner", async () => {
    const runner = createRunner();
    const gen = runner.stream(
      triageWorkflow,
      {},
      {
        onCheckpoint: async () => true,
      },
    );
    const types: string[] = [];
    for await (const ev of gen) {
      types.push(ev.type);
    }
    expect(types[0]).toBe("workflow:start");
    expect(types).toContain("checkpoint");
    expect(types[types.length - 1]).toBe("workflow:complete");
    runner.close();
  });

  it("streams events and supports resume-false (rejected checkpoint)", async () => {
    const runner = createRunner();
    const events: string[] = [];
    try {
      for await (const ev of runner.stream(
        triageWorkflow,
        {},
        {
          onCheckpoint: async () => false,
        },
      )) {
        events.push(ev.type);
      }
    } catch {
      // driver throws on HITL rejection — expected
    }
    expect(events).toContain("checkpoint");
    expect(events[events.length - 1]).toBe("workflow:error");
    runner.close();
  });
});

describe("P2-6: stream — checkpoint does not break generator", () => {
  it("drains all events including workflow:complete even with checkpoint", async () => {
    const runner = createRunner();
    const types: string[] = [];

    // Simulate what the fixed server.ts does: don't break on checkpoint
    for await (const ev of runner.stream(
      triageWorkflow,
      {},
      {
        onCheckpoint: async () => true,
      },
    )) {
      types.push(ev.type);
    }

    expect(types).toContain("checkpoint");
    expect(types[types.length - 1]).toBe("workflow:complete");
    runner.close();
  });
});
