import { AgentHitlConflictError } from "@ageflow/core";
import { describe, expect, it, vi } from "vitest";
import { CodexRunner, CodexSubprocessError } from "../codex-runner.js";
import type {
  SpawnFn,
  SpawnResult,
  SpawnSyncFn,
  SpawnSyncResult,
} from "../codex-runner.js";

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

/**
 * Build a real `codex exec --json` event stream.
 * Format observed in Codex CLI v0.59.0:
 *   thread.started → turn.started → item.completed (agent_message) → turn.completed
 */
function makeCodexEventStream(
  agentMessage: string,
  threadId = "thread-123",
  tokensIn = 10,
  tokensOut = 20,
): string {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: agentMessage },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: tokensIn,
        cached_input_tokens: 0,
        output_tokens: tokensOut,
      },
    }),
  ];
  return `${lines.join("\n")}\n`;
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

  it("parses real codex --version output format (semver + build hash)", async () => {
    // Real codex --version: "0.59.0 (29a7fe0d-2b17-43e2-b3bb-8fed03d1ce03)"
    const spawnSync: SpawnSyncFn = vi
      .fn()
      .mockReturnValueOnce(makeSpawnSyncResult(0, "/usr/bin/codex"))
      .mockReturnValueOnce(
        makeSpawnSyncResult(0, "0.59.0 (29a7fe0d-2b17-43e2-b3bb-8fed03d1ce03)"),
      );

    const runner = new CodexRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.59.0");
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
      .mockReturnValueOnce(makeSpawnSyncResult(0, "/usr/bin/codex"))
      .mockReturnValueOnce(makeSpawnSyncResult(1, "", "permission denied"));

    const runner = new CodexRunner({ spawnSync });
    const result = await runner.validate();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("--version failed");
  });
});

// ─── spawn() tests ────────────────────────────────────────────────────────────

describe("CodexRunner.spawn()", () => {
  it("parses real codex event stream correctly", async () => {
    const agentMessage = JSON.stringify({ answer: "42" });
    const eventStream = makeCodexEventStream(
      agentMessage,
      "thread-abc",
      100,
      200,
    );

    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "What is the answer?" });

    expect(result.stdout).toBe(agentMessage);
    expect(result.sessionHandle).toBe("thread-abc");
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(200);
  });

  it("takes the last agent_message when multiple item.completed events", async () => {
    // Regression: tool calls and reasoning items precede the final agent_message
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-multi" }),
      JSON.stringify({ type: "turn.started" }),
      // Tool call item — not agent_message, should be ignored
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "tool_call", text: "calling bash..." },
      }),
      // Intermediate reasoning item — should be ignored
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "reasoning", text: "thinking..." },
      }),
      // Final agent_message — this is the result
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "Final answer" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 50, output_tokens: 10, cached_input_tokens: 0 },
      }),
    ];
    const eventStream = `${lines.join("\n")}\n`;

    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.stdout).toBe("Final answer");
    expect(result.sessionHandle).toBe("thread-multi");
    expect(result.tokensIn).toBe(50);
    expect(result.tokensOut).toBe(10);
  });

  it("includes model flag when model is provided", async () => {
    const eventStream = makeCodexEventStream("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test", model: "gpt-4o" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs).toContain("--model");
    expect(callArgs).toContain("gpt-4o");
  });

  it("does NOT include model flag when model is not provided", async () => {
    const eventStream = makeCodexEventStream("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs).not.toContain("--model");
  });

  it("uses 'codex exec resume <THREAD_ID>' subcommand for session resumption", async () => {
    const eventStream = makeCodexEventStream("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "continue", sessionHandle: "thread-xyz" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    // Correct shape: ["codex", "exec", "--json", "resume", "thread-xyz", "continue"]
    expect(callArgs).toContain("exec");
    expect(callArgs).toContain("resume");
    expect(callArgs).toContain("thread-xyz");
    // NOT a flag — resume is positional
    expect(callArgs).not.toContain("--conversation-id");
    expect(callArgs).not.toContain("--resume");
  });

  it("does NOT include resume subcommand for empty sessionHandle", async () => {
    const eventStream = makeCodexEventStream("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test", sessionHandle: "" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs).not.toContain("resume");
  });

  it("always uses 'codex exec --json' invocation shape", async () => {
    const eventStream = makeCodexEventStream("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({ prompt: "test" });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    expect(callArgs[0]).toBe("codex");
    expect(callArgs[1]).toBe("exec");
    expect(callArgs).toContain("--json");
    // Old flags must NOT appear
    expect(callArgs).not.toContain("--output-format");
    expect(callArgs).not.toContain("-q");
  });

  it("prepends system prompt before user prompt", async () => {
    const eventStream = makeCodexEventStream("{}");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    await runner.spawn({
      prompt: "User prompt here",
      systemPrompt: "You are a helpful assistant",
    });

    const callArgs = (spawnFn as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string[];
    const lastArg = callArgs[callArgs.length - 1] ?? "";
    expect(lastArg).toContain("You are a helpful assistant");
    expect(lastArg).toContain("User prompt here");
    expect(lastArg.indexOf("You are a helpful assistant")).toBeLessThan(
      lastArg.indexOf("User prompt here"),
    );
  });

  it("throws CodexSubprocessError on non-zero exit code", async () => {
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult("", 1, "permission denied"));
    const runner = new CodexRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(
      CodexSubprocessError,
    );
  });

  it("throws CodexSubprocessError with stderr content", async () => {
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult("", 2, "authentication failed"));
    const runner = new CodexRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(
      "authentication failed",
    );
  });

  it("throws AgentHitlConflictError on [y/n] in non-JSON stdout", async () => {
    const hitlOutput = "Do you want to proceed? [y/n]\n";
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(hitlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(
      AgentHitlConflictError,
    );
  });

  it("throws AgentHitlConflictError on (Y/n) in non-JSON stdout", async () => {
    const hitlOutput = "Continue? (Y/n)\n";
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(hitlOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    await expect(runner.spawn({ prompt: "test" })).rejects.toThrow(
      AgentHitlConflictError,
    );
  });

  it("does NOT throw AgentHitlConflictError when agent_message text contains [y/n]", async () => {
    // Regression: HITL check must NOT scan JSON event content.
    const agentMessage = JSON.stringify({
      answer: "Please choose [y/n] to proceed",
    });
    const eventStream = makeCodexEventStream(
      agentMessage,
      "thread-abc",
      10,
      20,
    );
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.stdout).toBe(agentMessage);
  });

  it("returns thread_id as sessionHandle", async () => {
    const eventStream = makeCodexEventStream("{}", "thread-42");
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(eventStream));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.sessionHandle).toBe("thread-42");
  });

  it("returns empty sessionHandle when no thread.started event", async () => {
    // Only turn events, no thread.started
    const lines = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "hello" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 5, output_tokens: 5, cached_input_tokens: 0 },
      }),
    ];
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(`${lines.join("\n")}\n`));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.sessionHandle).toBe("");
  });

  it("falls back to raw stdout when no agent_message event found", async () => {
    // Unexpected output (not valid codex events) — return raw so upstream can surface clearly
    const rawOutput = "Some unexpected output without JSON events\n";
    const spawnFn: SpawnFn = vi
      .fn()
      .mockReturnValue(makeSpawnResult(rawOutput));
    const runner = new CodexRunner({ spawn: spawnFn });

    const result = await runner.spawn({ prompt: "test" });
    expect(result.stdout).toBe(rawOutput);
    expect(result.sessionHandle).toBe("");
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });
});
