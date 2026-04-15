import { AgentHitlConflictError } from "@agentflow/core";
import { describe, expect, it, vi } from "vitest";
import { ClaudeRunner, ClaudeSubprocessError } from "../claude-runner.js";
import type {
  SpawnFn,
  SpawnResult,
  SpawnSyncFn,
  SpawnSyncResult,
} from "../claude-runner.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function encodeStr(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeSpawnSyncResult(
  exitCode: number,
  stdout: string,
  stderr = "",
): SpawnSyncResult {
  return {
    exitCode,
    stdout: encodeStr(stdout),
    stderr: encodeStr(stderr),
  };
}

function makeSpawnResult(
  stdout: string,
  exitCode = 0,
  stderr = "",
): SpawnResult {
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
  sessionId = "sess-123",
  tokensIn = 10,
  tokensOut = 20,
): string {
  const resultLine = JSON.stringify({
    type: "result",
    result: resultContent,
    session_id: sessionId,
    usage: {
      input_tokens: tokensIn,
      output_tokens: tokensOut,
    },
  });
  return `{"type":"assistant","message":"thinking..."}\n${resultLine}\n`;
}

// ─── validate() tests ─────────────────────────────────────────────────────────

describe("ClaudeRunner.validate()", () => {
  it("returns ok: true with version when claude is found", async () => {
    const spawnSync: SpawnSyncFn = vi
      .fn()
      // First call: which claude
      .mockReturnValueOnce(makeSpawnSyncResult(0, "/usr/local/bin/claude"))
      // Second call: claude --version
      .mockReturnValueOnce(makeSpawnSyncResult(0, "Claude CLI 1.2.3"));

    const runner = new ClaudeRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.2.3");
  });

  it("parses version string with just digits", async () => {
    const spawnSync: SpawnSyncFn = vi
      .fn()
      .mockReturnValueOnce(makeSpawnSyncResult(0, "/usr/bin/claude"))
      .mockReturnValueOnce(makeSpawnSyncResult(0, "2.0.1"));

    const runner = new ClaudeRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(true);
    expect(result.version).toBe("2.0.1");
  });

  it("returns ok: false when claude is not found on PATH", async () => {
    const spawnSync: SpawnSyncFn = vi
      .fn()
      .mockReturnValueOnce(makeSpawnSyncResult(1, "", "claude not found"));

    const runner = new ClaudeRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found on PATH");
  });

  it("returns ok: false when --version fails", async () => {
    const spawnSync: SpawnSyncFn = vi
      .fn()
      // which succeeds
      .mockReturnValueOnce(makeSpawnSyncResult(0, "/usr/bin/claude"))
      // --version fails
      .mockReturnValueOnce(makeSpawnSyncResult(1, "", "permission denied"));

    const runner = new ClaudeRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("--version failed");
  });
});

// ─── spawn() tests ────────────────────────────────────────────────────────────

describe("ClaudeRunner.spawn()", () => {
  it("parses JSONL output correctly", async () => {
    const resultJson = JSON.stringify({ answer: "42" });
    const jsonlOutput = makeJsonlOutput(resultJson, "sess-abc", 100, 200);

    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "What is the answer?" });

    expect(result.stdout).toBe(resultJson);
    expect(result.sessionHandle).toBe("sess-abc");
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(200);
  });

  it("uses last result line if multiple present", async () => {
    const firstResult = JSON.stringify({ answer: "first" });
    const secondResult = JSON.stringify({ answer: "second" });
    const jsonlOutput =
      `${JSON.stringify({ type: "result", result: firstResult, session_id: "sess-1", usage: { input_tokens: 5, output_tokens: 5 } })}\n` +
      `${JSON.stringify({ type: "result", result: secondResult, session_id: "sess-2", usage: { input_tokens: 10, output_tokens: 10 } })}\n`;

    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.stdout).toBe(secondResult);
    expect(result.sessionHandle).toBe("sess-2");
  });

  it("includes model flag when model is provided", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test", model: "claude-opus-4-6" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs).toContain("--model");
    expect(callArgs).toContain("claude-opus-4-6");
  });

  it("includes allowedTools when tools are provided", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test", tools: ["bash", "read"] });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs).toContain("--allowedTools");
    expect(callArgs).toContain("bash,read");
  });

  it("includes resume flag when sessionHandle is provided", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test", sessionHandle: "sess-xyz" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs).toContain("--resume");
    expect(callArgs).toContain("sess-xyz");
  });

  it("does NOT include resume flag for empty sessionHandle", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test", sessionHandle: "" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs).not.toContain("--resume");
  });

  it("includes disallowedTools for denied permissions", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await runner.spawn({
      prompt: "test",
      permissions: { bash: false, read: true, write: false },
    });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs).toContain("--disallowedTools");
    const disallowedIdx = callArgs.indexOf("--disallowedTools");
    const disallowedValue = callArgs[disallowedIdx + 1] ?? "";
    expect(disallowedValue).toContain("bash");
    expect(disallowedValue).toContain("write");
    expect(disallowedValue).not.toContain("read");
  });

  it("prepends system prompt before user prompt", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await runner.spawn({
      prompt: "User prompt here",
      systemPrompt: "You are a helpful assistant",
    });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    const lastArg = callArgs[callArgs.length - 1] ?? "";
    expect(lastArg).toContain("You are a helpful assistant");
    expect(lastArg).toContain("User prompt here");
    // System prompt comes before user prompt
    expect(lastArg.indexOf("You are a helpful assistant")).toBeLessThan(
      lastArg.indexOf("User prompt here"),
    );
  });

  it("throws ClaudeSubprocessError on non-zero exit code", async () => {
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult("", 1, "permission denied"));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(
      ClaudeSubprocessError,
    );
  });

  it("throws ClaudeSubprocessError with stderr content", async () => {
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult("", 2, "authentication failed"));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(
      "authentication failed",
    );
  });

  it("throws AgentHitlConflictError on [y/n] in stdout", async () => {
    const hitlOutput = "Do you want to proceed? [y/n]\n";
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(hitlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(
      AgentHitlConflictError,
    );
  });

  it("throws AgentHitlConflictError on (Y/n) in stdout", async () => {
    const hitlOutput = "Continue? (Y/n)\n";
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(hitlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(
      AgentHitlConflictError,
    );
  });

  it("extracts session handle from result line", async () => {
    const jsonlOutput = makeJsonlOutput("{}", "session-42");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.sessionHandle).toBe("session-42");
  });

  it("returns empty sessionHandle when no session_id in result", async () => {
    const resultLine = JSON.stringify({
      type: "result",
      result: "{}",
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(resultLine));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.sessionHandle).toBe("");
  });

  it("handles output with no JSONL result line (raw stdout fallback)", async () => {
    const rawOutput = "Some raw text without JSON\n";
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(rawOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.stdout).toBe(rawOutput);
    expect(result.sessionHandle).toBe("");
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });

  it("does NOT throw AgentHitlConflictError when result content contains [y/n] text", async () => {
    // Regression test for B1: HITL check must NOT scan the JSON result content.
    // An agent response whose result field happens to say "answer [y/n]" is valid output.
    const resultContent = JSON.stringify({
      answer: "Please choose [y/n] to proceed",
    });
    const jsonlOutput = makeJsonlOutput(resultContent, "sess-abc", 10, 20);
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    // Should succeed — [y/n] is inside JSON, not a bare interactive prompt
    const result = await runner.spawn({ prompt: "test" });
    expect(result.stdout).toBe(resultContent);
  });

  it("still throws AgentHitlConflictError when [y/n] appears as a bare non-JSON line", async () => {
    // This simulates an actual interactive prompt leaking from stderr/non-JSON stdout
    const barePromptOutput = "Do you want to continue? [y/n]\n";
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(barePromptOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(
      AgentHitlConflictError,
    );
  });

  it("always includes --output-format json --print flags", async () => {
    const jsonlOutput = makeJsonlOutput("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(jsonlOutput));
    const runner = new ClaudeRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs).toContain("--output-format");
    expect(callArgs).toContain("json");
    expect(callArgs).toContain("--print");
  });
});
