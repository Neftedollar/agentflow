import { AgentFlowError, AgentHitlConflictError } from "@ageflow/core";
import type { Runner, RunnerSpawnArgs, RunnerSpawnResult } from "@ageflow/core";
import { renderCodexMcpFlags } from "./mcp-render.js";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class CodexSubprocessError extends AgentFlowError {
  readonly code = "subprocess_error" as const;
  constructor(
    readonly exitCode: number,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(`Codex subprocess exited with code ${exitCode}: ${stderr}`, options);
  }
}

// ─── JSONL event types (codex exec --json output format, v0.59.0+) ──────────
//
// Observed event stream:
//   {"type":"thread.started","thread_id":"019d9277-..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"Hi."}}
//   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
//
// Session handle = thread_id from thread.started.
// Result text    = last item.completed where item.type === "agent_message".
// Token counts   = turn.completed.usage.{input,output}_tokens.

interface CodexThreadStarted {
  type: "thread.started";
  thread_id?: string;
}

interface CodexItemCompleted {
  type: "item.completed";
  item?: {
    type?: string;
    text?: string;
  };
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface CodexJsonLine {
  type: string;
  [key: string]: unknown;
}

// ─── Injectable subprocess interface (enables testing without real Bun) ───────

export interface SpawnSyncResult {
  exitCode: number;
  stdout: Uint8Array | ArrayBuffer;
  stderr: Uint8Array | ArrayBuffer;
}

export interface SpawnResult {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
}

export type SpawnSyncFn = (
  cmd: string[],
  opts?: { stdout: string; stderr: string },
) => SpawnSyncResult;
export type SpawnFn = (
  cmd: string[],
  opts?: { stdout: string; stderr: string },
) => SpawnResult;

function defaultSpawnSync(
  cmd: string[],
  _opts?: { stdout: string; stderr: string },
): SpawnSyncResult {
  const result = Bun.spawnSync(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    // Use -1 as sentinel to distinguish signal-killed (null) from explicit exit 1
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout ?? new Uint8Array(),
    stderr: result.stderr ?? new Uint8Array(),
  };
}

function defaultSpawn(
  cmd: string[],
  _opts?: { stdout: string; stderr: string },
): SpawnResult {
  const proc = Bun.spawn(cmd, {
    stdin: "ignore", // C5: prevent stdin inheritance / "Reading additional input..." prompt
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
  };
}

// ─── CodexRunner ──────────────────────────────────────────────────────────────

export interface CodexRunnerOptions {
  /** Override spawn sync for testing */
  spawnSync?: SpawnSyncFn;
  /** Override spawn for testing */
  spawn?: SpawnFn;
}

export class CodexRunner implements Runner {
  private readonly _spawnSync: SpawnSyncFn;
  private readonly _spawn: SpawnFn;

  constructor(opts?: CodexRunnerOptions) {
    this._spawnSync = opts?.spawnSync ?? defaultSpawnSync;
    this._spawn = opts?.spawn ?? defaultSpawn;
  }

  async validate(): Promise<{ ok: boolean; version?: string; error?: string }> {
    // Check if codex is on PATH
    const whichResult = this._spawnSync(["which", "codex"]);

    if (whichResult.exitCode !== 0) {
      return {
        ok: false,
        error:
          "codex CLI not found on PATH. Install via: npm install -g @openai/codex",
      };
    }

    // Get version
    const versionResult = this._spawnSync(["codex", "--version"]);

    if (versionResult.exitCode !== 0) {
      const stderr = new TextDecoder().decode(versionResult.stderr);
      return { ok: false, error: `codex --version failed: ${stderr}` };
    }

    const versionOutput = new TextDecoder().decode(versionResult.stdout).trim();
    // Real codex reports e.g. "0.59.0 (29a7fe0d-...)" — extract semver portion
    const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch?.[1] ?? versionOutput;

    return { ok: true, version };
  }

  async spawn(args: RunnerSpawnArgs): Promise<RunnerSpawnResult> {
    // Codex CLI invocation: `codex exec --json [--model M] [--skip-git-repo-check] "<prompt>"`
    // Session resumption:   `codex exec --json resume <THREAD_ID> "<prompt>"`
    const subArgs: string[] = ["--json"];

    if (args.model !== undefined) {
      subArgs.push("--model", args.model);
    }

    // Build final prompt: prepend system prompt if provided
    let finalPrompt = args.prompt;
    if (args.systemPrompt !== undefined && args.systemPrompt !== "") {
      finalPrompt = `${args.systemPrompt}\n\n---\n\n${args.prompt}`;
    }

    // Emit MCP flags when mcpServers are provided (placed after subArgs, before prompt)
    const mcpFlags =
      args.mcpServers !== undefined && args.mcpServers.length > 0
        ? renderCodexMcpFlags(args.mcpServers)
        : [];

    // Session resumption uses a positional subcommand, not a flag
    let cmd: string[];
    if (args.sessionHandle !== undefined && args.sessionHandle !== "") {
      cmd = [
        "codex",
        "exec",
        ...subArgs,
        ...mcpFlags,
        "resume",
        args.sessionHandle,
        finalPrompt,
      ];
    } else {
      cmd = ["codex", "exec", ...subArgs, ...mcpFlags, finalPrompt];
    }

    const proc = this._spawn(cmd);

    const stdoutStream = proc.stdout;
    const stderrStream = proc.stderr;

    const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
      stdoutStream !== null
        ? new Response(stdoutStream).arrayBuffer()
        : Promise.resolve(new ArrayBuffer(0)),
      stderrStream !== null
        ? new Response(stderrStream).arrayBuffer()
        : Promise.resolve(new ArrayBuffer(0)),
      proc.exited,
    ]);

    const stdout = new TextDecoder().decode(stdoutBytes);
    const stderr = new TextDecoder().decode(stderrBytes);

    if (exitCode !== 0) {
      throw new CodexSubprocessError(exitCode, stderr);
    }

    // Parse JSONL event stream from `codex exec --json`.
    // Non-JSON lines are separated for HITL detection to prevent false positives
    // when agent response text happens to contain "[y/n]".
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let threadId = "";
    let lastAgentMessage = "";
    let tokensIn = 0;
    let tokensOut = 0;
    const nonJsonLines: string[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as CodexJsonLine;

        switch (parsed.type) {
          case "thread.started": {
            const ev = parsed as unknown as CodexThreadStarted;
            threadId = ev.thread_id ?? "";
            break;
          }
          case "item.completed": {
            const ev = parsed as unknown as CodexItemCompleted;
            // Take last agent_message — tool calls and reasoning emit earlier items
            if (
              ev.item?.type === "agent_message" &&
              ev.item.text !== undefined
            ) {
              lastAgentMessage = ev.item.text;
            }
            break;
          }
          case "turn.completed": {
            const ev = parsed as unknown as CodexTurnCompleted;
            tokensIn = ev.usage?.input_tokens ?? 0;
            tokensOut = ev.usage?.output_tokens ?? 0;
            break;
          }
          // Other event types (turn.started, tool_call, etc.) are ignored
        }
      } catch {
        // Not valid JSON — collect for HITL detection below
        nonJsonLines.push(line);
      }
    }

    // Detect HITL prompts only in non-JSON output (interactive prompts are never
    // valid JSON events; checking full stdout would false-positive on response text).
    const hitlCheck = nonJsonLines.join("\n");
    if (
      /\[y\/n\]/i.test(hitlCheck) ||
      /\(Y\/n\)/i.test(hitlCheck) ||
      /\(y\/N\)/i.test(hitlCheck)
    ) {
      // Runners don't know their task name — runNode in the executor
      // catches this and re-throws with the real taskName.
      throw new AgentHitlConflictError("unknown");
    }

    if (lastAgentMessage === "" && lines.length > 0) {
      // No agent_message event found — return raw stdout so upstream can surface
      // the failure clearly rather than silently passing an empty string to Zod.
      return {
        stdout,
        sessionHandle: threadId,
        tokensIn,
        tokensOut,
      };
    }

    return {
      stdout: lastAgentMessage,
      sessionHandle: threadId,
      tokensIn,
      tokensOut,
    };
  }
}
