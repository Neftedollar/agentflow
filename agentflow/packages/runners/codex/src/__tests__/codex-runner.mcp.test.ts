import { describe, expect, it } from "vitest";
import { CodexRunner } from "../codex-runner.js";
import type { SpawnFn, SpawnResult } from "../codex-runner.js";

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

function makeJsonlOutput(text: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
  ].join("\n");
}

// ─── MCP flag tests ────────────────────────────────────────────────────────────

describe("CodexRunner MCP flags", () => {
  it("emits -c mcp_servers.* flags when mcpServers is set", async () => {
    let capturedCmd: string[] = [];
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return makeSpawnResult(makeJsonlOutput("ok"));
    };
    const runner = new CodexRunner({ spawn });
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
    expect(capturedCmd).toContain("-c");
    expect(capturedCmd).toContain("mcp_servers.filesystem.command=npx");
    expect(capturedCmd).toContain(
      'mcp_servers.filesystem.args=["-y","@modelcontextprotocol/server-filesystem","/tmp"]',
    );
    // Bug 1 fix: Codex uses `enabled_tools`, not `tools`
    expect(capturedCmd).toContain(
      'mcp_servers.filesystem.enabled_tools=["read_file"]',
    );
  });

  it("omits MCP flags when mcpServers is unset (no behaviour change)", async () => {
    let capturedCmd: string[] = [];
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return makeSpawnResult(makeJsonlOutput("ok"));
    };
    const runner = new CodexRunner({ spawn });
    await runner.spawn({ prompt: "p" });
    const hasMcp = capturedCmd.some((a) => a.startsWith("mcp_servers."));
    expect(hasMcp).toBe(false);
  });

  it("places MCP flags before the prompt positional", async () => {
    let capturedCmd: string[] = [];
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return makeSpawnResult(makeJsonlOutput("ok"));
    };
    const runner = new CodexRunner({ spawn });
    await runner.spawn({
      prompt: "my-prompt",
      mcpServers: [{ name: "x", command: "y" }],
    });
    const mcpIdx = capturedCmd.findIndex((a) => a.startsWith("mcp_servers."));
    const promptIdx = capturedCmd.indexOf("my-prompt");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeLessThan(promptIdx);
  });

  it("emits env as a TOML inline table (Codex -c parses TOML, not JSON)", async () => {
    let capturedCmd: string[] = [];
    const spawn: SpawnFn = (cmd) => {
      capturedCmd = cmd;
      return makeSpawnResult(makeJsonlOutput("ok"));
    };
    const runner = new CodexRunner({ spawn });
    await runner.spawn({
      prompt: "p",
      mcpServers: [
        { name: "gh", command: "npx", env: { GITHUB_TOKEN: "tok" } },
      ],
    });
    // Codex -c parses TOML: env must be a TOML inline table '{KEY="val"}'
    expect(capturedCmd).toContain('mcp_servers.gh.env={GITHUB_TOKEN="tok"}');
  });
});
