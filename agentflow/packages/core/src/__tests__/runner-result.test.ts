import { describe, expect, it } from "vitest";
import type { RunnerSpawnResult, ToolCallRecord } from "../index.js";

describe("RunnerSpawnResult", () => {
  it("allows toolCalls to be omitted (backward compat)", () => {
    const r: RunnerSpawnResult = {
      stdout: "hi",
      sessionHandle: "s1",
      tokensIn: 1,
      tokensOut: 2,
    };
    expect(r.toolCalls).toBeUndefined();
  });

  it("accepts a ToolCallRecord[]", () => {
    const record: ToolCallRecord = {
      name: "readFile",
      args: { path: "./x" },
      result: "contents",
      durationMs: 42,
    };
    const r: RunnerSpawnResult = {
      stdout: "ok",
      sessionHandle: "s2",
      tokensIn: 10,
      tokensOut: 20,
      toolCalls: [record],
    };
    expect(r.toolCalls?.[0]?.name).toBe("readFile");
  });
});
