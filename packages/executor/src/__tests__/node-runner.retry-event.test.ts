import { defineAgent } from "@ageflow/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runNode } from "../node-runner.js";

describe("runNode onRetry callback", () => {
  it("does NOT fire onRetry when max=1 and the single attempt fails (phantom event)", async () => {
    const alwaysFail = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        throw new Error("subprocess always fails");
      },
    };
    const a = defineAgent({
      runner: "x",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "p",
      retry: { max: 1, on: ["subprocess_error"], backoff: "fixed" },
    });
    const onRetry = vi.fn();
    await expect(
      runNode(
        { agent: a, input: {} },
        {},
        alwaysFail,
        "t",
        undefined,
        undefined,
        undefined,
        undefined, // hitlEnforcing
        onRetry,
      ),
    ).rejects.toThrow();
    // With max=1 there is no retry — onRetry must not be called
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("invokes onRetry(attempt, reason) before each retry attempt", async () => {
    let attempts = 0;
    const flaky = {
      validate: async () => ({ ok: true }),
      spawn: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("subprocess transient failure");
        return {
          stdout: JSON.stringify({ ok: true }),
          sessionHandle: "s",
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    };

    const a = defineAgent({
      runner: "x",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      prompt: () => "p",
      retry: { max: 3, on: ["subprocess_error"], backoff: "fixed" },
    });
    const onRetry = vi.fn();
    await runNode(
      { agent: a, input: {} },
      {},
      flaky,
      "t",
      undefined,
      undefined,
      undefined,
      undefined, // hitlEnforcing
      onRetry,
    );
    expect(onRetry).toHaveBeenCalledTimes(2); // two failures before success
    expect(onRetry.mock.calls[0]?.[0]).toBe(1); // attempt about to start (1, then 2)
    expect(String(onRetry.mock.calls[0]?.[1])).toMatch(/subprocess/);
  });
});
