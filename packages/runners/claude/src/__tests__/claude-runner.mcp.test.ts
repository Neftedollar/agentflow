import { describe, expect, it } from "vitest";
import { ClaudeRunner } from "../claude-runner.js";
import type { SpawnFn, SpawnResult } from "../claude-runner.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeJsonlOutput(resultContent: string): string {
  const resultLine = JSON.stringify({
    type: "result",
    result: resultContent,
    session_id: "sess-123",
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  return `${resultLine}\n`;
}

// ─── MCP flag tests ────────────────────────────────────────────────────────────

describe("ClaudeRunner MCP flags", () => {
  it("passes --mcp-config + --strict-mcp-config when mcpServers is set", async () => {
    let capturedCmd: string[] = [];
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return makeSpawnResult(makeJsonlOutput("ok"));
    };
    const runner = new ClaudeRunner({ spawn });
    await runner.spawn({
      prompt: "p",
      mcpServers: [
        {
          name: "filesystem",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          tools: ["read_file"],
        },
      ],
    });
    expect(capturedCmd).toContain("--mcp-config");
    expect(capturedCmd).toContain("--strict-mcp-config");
    // Allowlist projected to fully-qualified MCP tool name.
    const allowIdx = capturedCmd.indexOf("--allowedTools");
    expect(allowIdx).toBeGreaterThan(-1);
    expect(capturedCmd[allowIdx + 1]).toContain("mcp__filesystem__read_file");
  });

  it("omits MCP flags when mcpServers is unset (no behaviour change)", async () => {
    let capturedCmd: string[] = [];
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return makeSpawnResult(makeJsonlOutput("ok"));
    };
    const runner = new ClaudeRunner({ spawn });
    await runner.spawn({ prompt: "p" });
    expect(capturedCmd).not.toContain("--mcp-config");
    expect(capturedCmd).not.toContain("--strict-mcp-config");
  });

  it("omits --allowedTools for MCP servers without a tools allowlist", async () => {
    let capturedCmd: string[] = [];
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return makeSpawnResult(makeJsonlOutput("ok"));
    };
    const runner = new ClaudeRunner({ spawn });
    await runner.spawn({
      prompt: "p",
      mcpServers: [{ name: "x", command: "y" }],
    });
    expect(capturedCmd).toContain("--mcp-config");
    expect(capturedCmd).toContain("--strict-mcp-config");
    expect(capturedCmd).not.toContain("--allowedTools");
  });

  it("merges MCP allowed tools with existing args.tools", async () => {
    let capturedCmd: string[] = [];
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return makeSpawnResult(makeJsonlOutput("ok"));
    };
    const runner = new ClaudeRunner({ spawn });
    await runner.spawn({
      prompt: "p",
      tools: ["bash"],
      mcpServers: [{ name: "fs", command: "npx", tools: ["read_file"] }],
    });
    const allowIdx = capturedCmd.indexOf("--allowedTools");
    expect(allowIdx).toBeGreaterThan(-1);
    const allowValue = capturedCmd[allowIdx + 1] ?? "";
    expect(allowValue).toContain("bash");
    expect(allowValue).toContain("mcp__fs__read_file");
  });

  it("passes mcp-config JSON with the correct server shape", async () => {
    let capturedCmd: string[] = [];
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return makeSpawnResult(makeJsonlOutput("ok"));
    };
    const runner = new ClaudeRunner({ spawn });
    await runner.spawn({
      prompt: "p",
      mcpServers: [
        {
          name: "github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "tok" },
        },
      ],
    });
    const mcpIdx = capturedCmd.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThan(-1);
    const jsonStr = capturedCmd[mcpIdx + 1] ?? "";
    const parsed = JSON.parse(jsonStr) as {
      mcpServers: Record<
        string,
        { command: string; args?: string[]; env?: Record<string, string> }
      >;
    };
    expect(parsed.mcpServers.github).toBeDefined();
    expect(parsed.mcpServers.github?.command).toBe("npx");
    expect(parsed.mcpServers.github?.env?.GITHUB_TOKEN).toBe("tok");
  });
});
