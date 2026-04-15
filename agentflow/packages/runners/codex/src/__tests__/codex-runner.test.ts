import { describe, it, expect, vi } from "vitest";
import { AgentHitlConflictError } from "@agentflow/core";
import { CodexRunner, CodexSubprocessError } from "../codex-runner.js";
import type { SpawnFn, SpawnResult, SpawnSyncFn, SpawnSyncResult } from "../codex-runner.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function encodeStr(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeSpawnSyncResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResult {
  return {
    exitCode,
    stdout: encodeStr(stdout),
    stderr: encodeStr(stderr),
  };
}

function makeSpawnResult(stdout: string, exitCode = 0, stderr = ""): SpawnResult {
  const encoder = new TextEncoder();

  const makeStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

  return {
    stdout: makeStream(encoder.encode(stdout)),
    stderr: makeStream(encoder.encode(stderr)),
    exited: Promise.resolve(exitCode),
  };
}

function makeJsonlOutput(
  resultContent: string,
  conversationId = "conv-123",
  tokensIn = 10,
  tokensOut = 20,
  usageFlavor: "new" | "legacy" = "new",
): string {
  const usage =
    usageFlavor === "new"
      ? { input_tokens: tokensIn, output_tokens: tokensOut }
      : { prompt_tokens: tokensIn, completion_tokens: tokensOut };

  const resultLine = JSON.stringify({
    type: "result",
    output: resultContent,
    conversation_id: conversationId,
    usage,
  });
  return `{"type":"assistant","message":"thinking..."}\n${resultLine}\n`;
}

// ─── validate() tests ─────────────────────────────────────────────────────────

describe("CodexRunner.validate()", () => {
  it("returns ok: true with version when codex is found", async () => {
    const spawnSync: SpawnSyncFn = vi
      .fn()
      // First call: which codex
      .mockReturnValueOnce(makeSpawnSyncResult(0, "/usr/local/bin/codex"))
      // Second call: codex --version
      .mockReturnValueOnce(makeSpawnSyncResult(0, "Codex CLI 1.2.3"));

    const runner = new CodexRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.2.3");
  });

  it("parses version string with just digits", async () => {
    const spawnSync: SpawnSyncFn = vi
      .fn()
      .mockReturnValueOnce(makeSpawnSyncResult(0, "/usr/bin/codex"))
      .mockReturnValueOnce(makeSpawnSyncResult(0, "2.0.1"));

    const runner = new CodexRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(true);
    expect(result.version).toBe("2.0.1");
  });

  it("returns ok: false when codex is not found on PATH", async () => {
    const spawnSync: SpawnSyncFn = vi
      .fn()
      .mockReturnValueOnce(makeSpawnSyncResult(1, "", "codex not found"));

    const runner = new CodexRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found on PATH");
  });

  it("returns ok: false when --version fails", async () => {
    const spawnSync: SpawnSyncFn = vi
      .fn()
      // which succeeds
      .mockReturnValueOnce(makeSpawnSyncResult(0, "/usr/bin/codex"))
      // --version fails
      .mockReturnValueOnce(makeSpawnSyncResult(1, "", "permission denied"));

    const runner = new CodexRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("--version failed");
  });
});

// ─── spawn() tests ────────────────────────────────────────────────────────────

describe("CodexRunner.spawn()", () => {
  it("parses JSONL output correctly", async () => {
    const resultJson = JSON.stringify({ answer: "42" });
    const jsonlOutput = makeJsonlOutput(resultJson, "conv-abc", 100, 200);

    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "What is the answer?" });

    expect(result.stdout).toBe(resultJson);
    expect(result.sessionHandle).toBe("conv-abc");
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(200);
  });

  it("handles legacy prompt_tokens/completion_tokens fields", async () => {
    const resultJson = JSON.stringify({ answer: "legacy" });
    const jsonlOutput = makeJsonlOutput(resultJson, "conv-legacy", 50, 75, "legacy");

    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "legacy usage test" });

    expect(result.stdout).toBe(resultJson);
    expect(result.tokensIn).toBe(50);
    expect(result.tokensOut).toBe(75);
  });

  it("falls back to result field when output field is absent", async () => {
    const resultContent = JSON.stringify({ answer: "fallback" });
    const resultLine = JSON.stringify({
      type: "result",
      result: resultContent,
      conversation_id: "conv-fallback",
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(resultLine));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "fallback test" });
    expect(result.stdout).toBe(resultContent);
    expect(result.sessionHandle).toBe("conv-fallback");
  });

  it("uses last result line if multiple present", async () => {
    const firstResult = JSON.stringify({ answer: "first" });
    const secondResult = JSON.stringify({ answer: "second" });
    const jsonlOutput =
      `${JSON.stringify({ type: "result", output: firstResult, conversation_id: "conv-1", usage: { input_tokens: 5, output_tokens: 5 } })}\n` +
      `${JSON.stringify({ type: "result", output: secondResult, conversation_id: "conv-2", usage: { input_tokens: 10, output_tokens: 10 } })}\n`;

    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.stdout).toBe(secondResult);
    expect(result.sessionHandle).toBe("conv-2");
  });

  it("includes model flag when model is provided", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test", model: "gpt-4o" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain("--model");
    expect(callArgs).toContain("gpt-4o");
  });

  it("does NOT include model flag when model is not provided", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(callArgs).not.toContain("--model");
  });

  it("includes conversation-id when sessionHandle is provided", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test", sessionHandle: "conv-xyz" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain("--conversation-id");
    expect(callArgs).toContain("conv-xyz");
  });

  it("does NOT include conversation-id for empty sessionHandle", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test", sessionHandle: "" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(callArgs).not.toContain("--conversation-id");
  });

  it("prepends system prompt before user prompt", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({
      prompt: "User prompt here",
      systemPrompt: "You are a helpful assistant",
    });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    const lastArg = callArgs[callArgs.length - 1] ?? "";
    expect(lastArg).toContain("You are a helpful assistant");
    expect(lastArg).toContain("User prompt here");
    // System prompt comes before user prompt
    expect(lastArg.indexOf("You are a helpful assistant")).toBeLessThan(
      lastArg.indexOf("User prompt here"),
    );
  });

  it("throws CodexSubprocessError on non-zero exit code", async () => {
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult("", 1, "permission denied"));
    const runner = new CodexRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(CodexSubprocessError);
  });

  it("throws CodexSubprocessError with stderr content", async () => {
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult("", 2, "authentication failed"));
    const runner = new CodexRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow("authentication failed");
  });

  it("throws AgentHitlConflictError on [y/n] in non-JSON stdout", async () => {
    const hitlOutput = "Do you want to proceed? [y/n]\n";
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(hitlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(AgentHitlConflictError);
  });

  it("throws AgentHitlConflictError on (Y/n) in non-JSON stdout", async () => {
    const hitlOutput = "Continue? (Y/n)\n";
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(hitlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(AgentHitlConflictError);
  });

  it("does NOT throw AgentHitlConflictError when result content contains [y/n] text", async () => {
    // Regression: HITL check must NOT scan the JSON result content.
    const resultContent = JSON.stringify({ answer: "Please choose [y/n] to proceed" });
    const jsonlOutput = makeJsonlOutput(resultContent, "conv-abc", 10, 20);
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.stdout).toBe(resultContent);
  });

  it("returns empty sessionHandle when no conversation_id in result", async () => {
    const resultLine = JSON.stringify({
      type: "result",
      output: "{}",
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(resultLine));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.sessionHandle).toBe("");
  });

  it("handles output with no JSONL result line (raw stdout fallback)", async () => {
    const rawOutput = "Some raw text without JSON\n";
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(rawOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.stdout).toBe(rawOutput);
    expect(result.sessionHandle).toBe("");
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });

  it("always includes --output-format json and -q flags", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain("--output-format");
    expect(callArgs).toContain("json");
    expect(callArgs).toContain("-q");
  });

  it("extracts session handle from conversation_id field", async () => {
    const jsonlOutput = makeJsonlOutput("{}", "conversation-42");
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.sessionHandle).toBe("conversation-42");
  });
});
