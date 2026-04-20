/**
 * mcp-serve.ts
 *
 * Implements `agentwf mcp serve <workflow>` CLI subcommand.
 *
 * Flags:
 *   --max-cost <n>        maximum cost in USD (overrides workflow.mcp.maxCostUsd)
 *   --no-max-cost         disable cost ceiling (null)
 *   --max-duration <n>    maximum duration in seconds
 *   --no-max-duration     disable duration ceiling
 *   --max-turns <n>       maximum agent turns
 *   --no-max-turns        disable turns ceiling
 *   --hitl <strategy>     HITL strategy: elicit | auto | fail (default: elicit)
 *   --name <name>         MCP server name (default: workflow name)
 *   --log-file <path>     write stderr log to a file
 *   --http                use Streamable HTTP transport instead of stdio
 *   --port <n>            HTTP port (required with --http)
 *   --host <addr>         HTTP bind address (default: 127.0.0.1)
 *   --auth-bearer <token> bearer token for HTTP auth (required for non-loopback --host)
 *
 * Uses raw argv parsing so the unit test can import parseMcpServeArgs directly.
 */

import fs from "node:fs";
import path from "node:path";
import type { WorkflowDef } from "@ageflow/core";
import type { CliCeilings, HitlStrategy } from "@ageflow/mcp-server";
import {
  createHttpTransport,
  createSingleWorkflowServer,
  startStdioTransport,
} from "@ageflow/mcp-server";
import type { Command } from "commander";

// ─── Args model ──────────────────────────────────────────────────────────────

export interface McpServeArgs {
  readonly workflowFile: string;
  readonly maxCostUsd?: number | null;
  readonly maxDurationSec?: number | null;
  readonly maxTurns?: number | null;
  readonly hitlStrategy: HitlStrategy;
  readonly serverName?: string;
  readonly logFile?: string;
  /** Enable async job mode (--async flag). */
  readonly async?: boolean;
  /** Override default 30-minute job TTL in ms (--job-ttl <ms>). */
  readonly jobTtlMs?: number;
  /** Override default 1-hour checkpoint TTL in ms (--checkpoint-ttl <ms>). */
  readonly jobCheckpointTtlMs?: number;
  /** Persist async job registry to a SQLite database (--job-db <path>). */
  readonly jobDb?: string;
  /** Use Streamable HTTP transport instead of stdio (--http). */
  readonly http?: boolean;
  /** HTTP port (--port <n>, required with --http). */
  readonly port?: number;
  /** HTTP bind host (--host <addr>, default: 127.0.0.1). */
  readonly httpHost?: string;
  /** Bearer token for HTTP auth (--auth-bearer <token>). */
  readonly authBearer?: string;
}

// ─── Raw argv parser ─────────────────────────────────────────────────────────

/**
 * Parse raw argv array into McpServeArgs.
 *
 * Expected argv: the slice AFTER `agentwf mcp serve`, e.g.
 *   ["workflow.ts", "--max-cost", "1.5", "--hitl", "auto"]
 *
 * The workflowFile is the first positional argument.
 */
export function parseMcpServeArgs(argv: readonly string[]): McpServeArgs {
  const args = [...argv];

  // Extract workflow file (first non-flag argument)
  const workflowIdx = args.findIndex((a) => !a.startsWith("-"));
  if (workflowIdx === -1) {
    throw new Error(
      "Usage: agentwf mcp serve <workflow.ts> [flags]\n  Missing required workflow file argument.",
    );
  }
  const workflowFile = args[workflowIdx] as string;
  args.splice(workflowIdx, 1);

  let maxCostUsd: number | null | undefined = undefined;
  let maxDurationSec: number | null | undefined = undefined;
  let maxTurns: number | null | undefined = undefined;
  let hitlStrategy: HitlStrategy = "elicit";
  let serverName: string | undefined = undefined;
  let logFile: string | undefined = undefined;
  let asyncMode: boolean | undefined = undefined;
  let jobTtlMs: number | undefined = undefined;
  let jobCheckpointTtlMs: number | undefined = undefined;
  let jobDb: string | undefined = undefined;
  let httpMode: boolean | undefined = undefined;
  let httpPort: number | undefined = undefined;
  let httpHost: string | undefined = undefined;
  let authBearer: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case "--max-cost": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--max-cost requires a numeric argument");
        }
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(
            `--max-cost must be a non-negative number, got: ${val}`,
          );
        }
        maxCostUsd = n;
        break;
      }
      case "--no-max-cost":
        maxCostUsd = null;
        break;

      case "--max-duration": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--max-duration requires a numeric argument");
        }
        const n = Number(val);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(
            `--max-duration must be a positive number, got: ${val}`,
          );
        }
        maxDurationSec = n;
        break;
      }
      case "--no-max-duration":
        maxDurationSec = null;
        break;

      case "--max-turns": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--max-turns requires a numeric argument");
        }
        const n = Number(val);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `--max-turns must be a positive integer, got: ${val}`,
          );
        }
        maxTurns = n;
        break;
      }
      case "--no-max-turns":
        maxTurns = null;
        break;

      case "--hitl": {
        const val = args[++i];
        if (val !== "elicit" && val !== "auto" && val !== "fail") {
          throw new Error(
            `--hitl must be one of: elicit | auto | fail, got: ${val}`,
          );
        }
        hitlStrategy = val;
        break;
      }

      case "--name": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--name requires a string argument");
        }
        serverName = val;
        break;
      }

      case "--log-file": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--log-file requires a path argument");
        }
        logFile = val;
        break;
      }

      case "--async":
        asyncMode = true;
        break;

      case "--job-ttl": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--job-ttl requires a numeric argument (ms)");
        }
        const n = Number(val);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `--job-ttl must be a positive integer in ms, got: ${val}`,
          );
        }
        jobTtlMs = n;
        break;
      }

      case "--checkpoint-ttl": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--checkpoint-ttl requires a numeric argument (ms)");
        }
        const n = Number(val);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `--checkpoint-ttl must be a positive integer in ms, got: ${val}`,
          );
        }
        jobCheckpointTtlMs = n;
        break;
      }

      case "--job-db": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--job-db requires a path argument");
        }
        jobDb = val;
        break;
      }

      case "--http":
        httpMode = true;
        break;

      case "--port": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--port requires a numeric argument");
        }
        const n = Number(val);
        if (!Number.isInteger(n) || n <= 0 || n > 65535) {
          throw new Error(
            `--port must be a valid port number (1-65535), got: ${val}`,
          );
        }
        httpPort = n;
        break;
      }

      case "--host": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--host requires a host argument");
        }
        httpHost = val;
        break;
      }

      case "--auth-bearer": {
        const val = args[++i];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--auth-bearer requires a token argument");
        }
        authBearer = val;
        break;
      }

      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (
    asyncMode !== true &&
    (jobTtlMs !== undefined ||
      jobCheckpointTtlMs !== undefined ||
      jobDb !== undefined)
  ) {
    throw new Error("--job-ttl / --checkpoint-ttl / --job-db requires --async");
  }

  if (httpPort !== undefined && httpMode !== true) {
    throw new Error("--port requires --http");
  }
  if (httpHost !== undefined && httpMode !== true) {
    throw new Error("--host requires --http");
  }
  if (authBearer !== undefined && httpMode !== true) {
    throw new Error("--auth-bearer requires --http");
  }
  if (httpMode === true && httpPort === undefined) {
    throw new Error("--http requires --port <n>");
  }

  // Non-loopback host without auth is caught later in createHttpTransport, but
  // emit a clear CLI error here so users see it immediately.
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  const resolvedHost = httpHost ?? "127.0.0.1";
  if (
    httpMode === true &&
    !loopbackHosts.has(resolvedHost) &&
    authBearer === undefined
  ) {
    throw new Error(
      `HTTP transport on non-loopback host "${resolvedHost}" requires --auth-bearer; this prevents accidentally exposing your workflows to the public internet.`,
    );
  }

  return {
    workflowFile,
    hitlStrategy,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxDurationSec !== undefined ? { maxDurationSec } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(serverName !== undefined ? { serverName } : {}),
    ...(logFile !== undefined ? { logFile } : {}),
    ...(asyncMode !== undefined ? { async: asyncMode } : {}),
    ...(jobTtlMs !== undefined ? { jobTtlMs } : {}),
    ...(jobCheckpointTtlMs !== undefined ? { jobCheckpointTtlMs } : {}),
    ...(jobDb !== undefined ? { jobDb } : {}),
    ...(httpMode !== undefined ? { http: httpMode } : {}),
    ...(httpPort !== undefined ? { port: httpPort } : {}),
    ...(httpHost !== undefined ? { httpHost } : {}),
    ...(authBearer !== undefined ? { authBearer } : {}),
  };
}

// ─── Run action ───────────────────────────────────────────────────────────────

async function runMcpServe(rawArgv: string[]): Promise<void> {
  let parsed: McpServeArgs;
  try {
    parsed = parseMcpServeArgs(rawArgv);
  } catch (err) {
    process.stderr.write(
      `agentwf mcp serve: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Load workflow file
  const resolvedPath = path.resolve(parsed.workflowFile);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(resolvedPath)) as Record<string, unknown>;
  } catch (importErr) {
    process.stderr.write(
      `Cannot import workflow file "${parsed.workflowFile}": ${
        importErr instanceof Error ? importErr.message : String(importErr)
      }\n`,
    );
    process.exit(1);
  }

  const workflow = (mod.default ?? mod.workflow) as WorkflowDef | undefined;

  if (workflow === undefined || !("tasks" in workflow)) {
    process.stderr.write(
      `Invalid workflow file: must export a default WorkflowDef (found: ${typeof (mod.default ?? mod.workflow)})\n`,
    );
    process.exit(1);
  }

  // Build ceilings
  const cliCeilings: CliCeilings = {
    ...(parsed.maxCostUsd !== undefined
      ? { maxCostUsd: parsed.maxCostUsd }
      : {}),
    ...(parsed.maxDurationSec !== undefined
      ? { maxDurationSec: parsed.maxDurationSec }
      : {}),
    ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
  };

  // Determine server name
  const serverName = parsed.serverName ?? workflow.name;

  // Set up stderr writer (optionally tee to a log file)
  let logStream: fs.WriteStream | undefined = undefined;
  if (parsed.logFile !== undefined) {
    logStream = fs.createWriteStream(parsed.logFile, { flags: "a" });
  }

  const stderr = (line: string): void => {
    process.stderr.write(line);
    logStream?.write(line);
  };

  // Create MCP server handle (single-workflow CLI path)
  const handle = createSingleWorkflowServer({
    workflow,
    cliCeilings,
    hitlStrategy: parsed.hitlStrategy,
    stderr,
    ...(parsed.async === true ? { async: true } : {}),
    ...(parsed.jobTtlMs !== undefined ? { jobTtlMs: parsed.jobTtlMs } : {}),
    ...(parsed.jobCheckpointTtlMs !== undefined
      ? { jobCheckpointTtlMs: parsed.jobCheckpointTtlMs }
      : {}),
    ...(parsed.jobDb !== undefined ? { jobDbPath: parsed.jobDb } : {}),
  });

  if (parsed.http === true) {
    // ── HTTP transport path ────────────────────────────────────────────────────
    const httpHandle = createHttpTransport(
      handle,
      {
        port: parsed.port as number,
        ...(parsed.httpHost !== undefined ? { host: parsed.httpHost } : {}),
        ...(parsed.authBearer !== undefined
          ? { auth: { type: "bearer" as const, token: parsed.authBearer } }
          : { auth: { type: "none" as const } }),
        stderr,
      },
      serverName,
      "0.1.0",
    );

    await httpHandle.start();

    const shutdown = async (): Promise<void> => {
      try {
        await httpHandle.stop();
      } catch {
        // ignore
      }
      logStream?.end();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    // HTTP transport: don't exit on stdin end (no stdin in HTTP mode)
  } else {
    // ── stdio transport path (default) ────────────────────────────────────────
    const server = await startStdioTransport({
      serverName,
      serverVersion: "0.1.0",
      handle,
      stderr,
    });

    // Graceful shutdown: close SDK server, flush log file, exit cleanly.
    const shutdown = async (): Promise<void> => {
      try {
        await server.close();
      } catch {
        // ignore close errors — we're shutting down anyway
      }
      logStream?.end();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    process.stdin.on("end", shutdown);
  }
}

// ─── Commander registration ───────────────────────────────────────────────────

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("MCP server integration commands");

  mcp
    .command("serve <workflow> [args...]")
    .description(
      "Expose a workflow as an MCP tool via stdio or HTTP transport\n\n" +
        "Flags (passed after the workflow file):\n" +
        "  --max-cost <n>         max cost in USD\n" +
        "  --no-max-cost          disable cost ceiling\n" +
        "  --max-duration <n>     max duration in seconds\n" +
        "  --no-max-duration      disable duration ceiling\n" +
        "  --max-turns <n>        max agent turns\n" +
        "  --no-max-turns         disable turns ceiling\n" +
        "  --hitl <strategy>      elicit | auto | fail (default: elicit)\n" +
        "  --name <name>          MCP server name\n" +
        "  --log-file <path>      log stderr to file\n" +
        "  --async                enable async job mode (5 extra tools)\n" +
        "  --job-ttl <ms>         job TTL in ms (default: 1800000, requires --async)\n" +
        "  --checkpoint-ttl <ms>  checkpoint TTL in ms (default: 3600000, requires --async)\n" +
        "  --job-db <path>        persist async job registry to SQLite (requires --async)\n" +
        "  --http                 use Streamable HTTP transport instead of stdio\n" +
        "  --port <n>             HTTP port (required with --http)\n" +
        "  --host <addr>          HTTP bind address (default: 127.0.0.1, requires --http)\n" +
        "  --auth-bearer <token>  bearer token for HTTP auth (required for non-loopback --host)",
    )
    .allowUnknownOption(true) // raw flags parsed manually
    .action(async (workflowFile: string, extraArgs: string[]) => {
      // Reconstruct argv for the raw parser
      const argv = [workflowFile, ...extraArgs];
      await runMcpServe(argv);
    });
}
