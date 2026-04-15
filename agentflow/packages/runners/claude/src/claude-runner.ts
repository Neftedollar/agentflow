import { AgentFlowError, AgentHitlConflictError } from "@ageflow/core";
import type {
  Runner,
  RunnerSpawnArgs,
  RunnerSpawnResult,
} from "@ageflow/core";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ClaudeSubprocessError extends AgentFlowError {
  readonly code = "subprocess_error" as const;
  constructor(
    readonly exitCode: number,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(`Claude subprocess exited with code ${exitCode}: ${stderr}`, options);
  }
}

// ─── JSONL result types ───────────────────────────────────────────────────────

interface ClaudeResultLine {
  type: "result";
  result: string;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface ClaudeJsonLine {
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
    stdin: "ignore", // prevent stdin inheritance / interactive prompt leakage
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
  };
}

// ─── ClaudeRunner ─────────────────────────────────────────────────────────────

export interface ClaudeRunnerOptions {
  /** Override spawn sync for testing */
  spawnSync?: SpawnSyncFn;
  /** Override spawn for testing */
  spawn?: SpawnFn;
}

export class ClaudeRunner implements Runner {
  private readonly _spawnSync: SpawnSyncFn;
  private readonly _spawn: SpawnFn;

  constructor(opts?: ClaudeRunnerOptions) {
    this._spawnSync = opts?.spawnSync ?? defaultSpawnSync;
    this._spawn = opts?.spawn ?? defaultSpawn;
  }

  async validate(): Promise<{ ok: boolean; version?: string; error?: string }> {
    // Check if claude is on PATH
    const whichResult = this._spawnSync(["which", "claude"]);

    if (whichResult.exitCode !== 0) {
      return {
        ok: false,
        error:
          "claude CLI not found on PATH. Install via: npm install -g @anthropic-ai/claude-code",
      };
    }

    // Get version
    const versionResult = this._spawnSync(["claude", "--version"]);

    if (versionResult.exitCode !== 0) {
      const stderr = new TextDecoder().decode(versionResult.stderr);
      return { ok: false, error: `claude --version failed: ${stderr}` };
    }

    const versionOutput = new TextDecoder().decode(versionResult.stdout).trim();
    // Parse version string — expect something like "1.2.3" or "Claude CLI v1.2.3"
    const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch?.[1] ?? versionOutput;

    return { ok: true, version };
  }

  async spawn(args: RunnerSpawnArgs): Promise<RunnerSpawnResult> {
    const cliArgs: string[] = ["--output-format", "json", "--print"];

    if (args.model !== undefined) {
      cliArgs.push("--model", args.model);
    }

    if (args.tools !== undefined && args.tools.length > 0) {
      cliArgs.push("--allowedTools", args.tools.join(","));
    }

    if (args.sessionHandle !== undefined && args.sessionHandle !== "") {
      cliArgs.push("--resume", args.sessionHandle);
    }

    // Build denied tools list from permissions map
    if (args.permissions !== undefined) {
      const deniedTools = Object.entries(args.permissions)
        .filter(([, allowed]) => allowed === false)
        .map(([tool]) => tool);
      if (deniedTools.length > 0) {
        cliArgs.push("--disallowedTools", deniedTools.join(","));
      }
    }

    // Build final prompt: prepend system prompt if provided
    let finalPrompt = args.prompt;
    if (args.systemPrompt !== undefined && args.systemPrompt !== "") {
      finalPrompt = `${args.systemPrompt}\n\n---\n\n${args.prompt}`;
    }

    const proc = this._spawn(["claude", ...cliArgs, finalPrompt]);

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
      throw new ClaudeSubprocessError(exitCode, stderr);
    }

    // Parse JSONL output: split on newlines, parse each line as JSON.
    // Non-JSON lines are collected separately for HITL detection — this prevents
    // false positives when the agent's result content contains "[y/n]" text.
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let resultLine: ClaudeResultLine | undefined;
    const nonJsonLines: string[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ClaudeJsonLine;
        if (parsed.type === "result") {
          resultLine = parsed as unknown as ClaudeResultLine;
        }
      } catch {
        // Not valid JSON — collect for HITL detection below
        nonJsonLines.push(line);
      }
    }

    // Detect HITL prompts only in non-JSON output (interactive prompts are never
    // valid JSON lines; checking full stdout would false-positive on result content).
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

    if (resultLine === undefined) {
      // If no JSONL result line found, treat entire stdout as the result
      return {
        stdout,
        sessionHandle: "",
        tokensIn: 0,
        tokensOut: 0,
      };
    }

    const resultContent = resultLine.result;
    const sessionHandle = resultLine.session_id ?? "";
    const tokensIn = resultLine.usage?.input_tokens ?? 0;
    const tokensOut = resultLine.usage?.output_tokens ?? 0;

    return {
      stdout: resultContent,
      sessionHandle,
      tokensIn,
      tokensOut,
    };
  }
}
