/**
 * mcp-serve.test.ts
 *
 * Unit tests for parseMcpServeArgs — pure argv parsing, no process or I/O.
 * Also includes a subprocess test for graceful SIGTERM shutdown.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMcpServeArgs } from "../commands/mcp-serve.js";

// ─── Graceful shutdown test ───────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path to the agentflow monorepo root (4 levels up from __tests__). */
const MONOREPO_ROOT = path.resolve(__dirname, "../../../../");
const CLI_BIN = path.join(MONOREPO_ROOT, "packages/cli/src/bin.ts");
const WORKFLOW = path.join(MONOREPO_ROOT, "examples/mcp-server/workflow.ts");

describe("mcp serve graceful shutdown", () => {
  // TODO(#64): flaky — subprocess timing varies on CI (banner delay, handler
  // registration race). Skip until the test is rewritten with an in-memory
  // transport that doesn't rely on real process spawning.
  it.skip(
    "exits with code 0 after SIGTERM",
    async () => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "bun",
          ["run", CLI_BIN, "mcp", "serve", WORKFLOW, "--hitl", "auto"],
          { stdio: ["pipe", "pipe", "pipe"] },
        );

        let stderrBuf = "";
        let settled = false;

        const done = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        // Emit SIGTERM after seeing the startup banner on stderr.
        // A short delay ensures the signal handlers are registered before
        // the signal arrives (handlers are registered after connect resolves).
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          if (stderrBuf.includes("listening on stdio") && !settled) {
            setTimeout(() => child.kill("SIGTERM"), 100);
          }
        });

        child.on("exit", (code, signal) => {
          if (code === 0) {
            done();
          } else {
            done(
              new Error(
                `Expected exit code 0 but got code=${code} signal=${signal}`,
              ),
            );
          }
        });

        child.on("error", done);

        // Hard timeout — if the server never starts or never exits, fail the test.
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
            done(
              new Error(
                `Server did not start or did not exit within 5 s. stderr=${stderrBuf}`,
              ),
            );
          }
        }, 5000);
      });
    },
    { timeout: 8000 },
  );
});

describe("parseMcpServeArgs", () => {
  it("parses workflow file as first positional", () => {
    const args = parseMcpServeArgs(["workflow.ts"]);
    expect(args.workflowFile).toBe("workflow.ts");
    expect(args.hitlStrategy).toBe("elicit"); // default
  });

  it("parses --max-cost", () => {
    const args = parseMcpServeArgs(["wf.ts", "--max-cost", "1.5"]);
    expect(args.maxCostUsd).toBe(1.5);
  });

  it("parses --no-max-cost as null", () => {
    const args = parseMcpServeArgs(["wf.ts", "--no-max-cost"]);
    expect(args.maxCostUsd).toBeNull();
  });

  it("parses --max-duration", () => {
    const args = parseMcpServeArgs(["wf.ts", "--max-duration", "120"]);
    expect(args.maxDurationSec).toBe(120);
  });

  it("parses --no-max-duration as null", () => {
    const args = parseMcpServeArgs(["wf.ts", "--no-max-duration"]);
    expect(args.maxDurationSec).toBeNull();
  });

  it("parses --max-turns", () => {
    const args = parseMcpServeArgs(["wf.ts", "--max-turns", "10"]);
    expect(args.maxTurns).toBe(10);
  });

  it("parses --no-max-turns as null", () => {
    const args = parseMcpServeArgs(["wf.ts", "--no-max-turns"]);
    expect(args.maxTurns).toBeNull();
  });

  it("parses --hitl auto", () => {
    const args = parseMcpServeArgs(["wf.ts", "--hitl", "auto"]);
    expect(args.hitlStrategy).toBe("auto");
  });

  it("parses --hitl fail", () => {
    const args = parseMcpServeArgs(["wf.ts", "--hitl", "fail"]);
    expect(args.hitlStrategy).toBe("fail");
  });

  it("parses --name", () => {
    const args = parseMcpServeArgs(["wf.ts", "--name", "my-server"]);
    expect(args.serverName).toBe("my-server");
  });

  it("parses --log-file", () => {
    const args = parseMcpServeArgs(["wf.ts", "--log-file", "/tmp/mcp.log"]);
    expect(args.logFile).toBe("/tmp/mcp.log");
  });

  it("combines multiple flags", () => {
    const args = parseMcpServeArgs([
      "workflow.ts",
      "--max-cost",
      "2",
      "--hitl",
      "auto",
      "--max-turns",
      "5",
      "--name",
      "greet-server",
    ]);
    expect(args.workflowFile).toBe("workflow.ts");
    expect(args.maxCostUsd).toBe(2);
    expect(args.hitlStrategy).toBe("auto");
    expect(args.maxTurns).toBe(5);
    expect(args.serverName).toBe("greet-server");
  });

  it("throws when no workflow file provided", () => {
    expect(() => parseMcpServeArgs([])).toThrow(
      /Missing required workflow file/,
    );
  });

  it("throws on invalid --hitl value", () => {
    expect(() => parseMcpServeArgs(["wf.ts", "--hitl", "invalid"])).toThrow(
      /--hitl must be one of/,
    );
  });

  it("throws on invalid --max-cost value", () => {
    expect(() => parseMcpServeArgs(["wf.ts", "--max-cost", "abc"])).toThrow(
      /--max-cost must be a non-negative number/,
    );
  });

  it("throws on unknown flag", () => {
    expect(() => parseMcpServeArgs(["wf.ts", "--unknown-flag"])).toThrow(
      /Unknown flag/,
    );
  });
});

describe("parseMcpServeArgs: async mode flags (#18)", () => {
  it("parses --async without a value", () => {
    const parsed = parseMcpServeArgs(["wf.ts", "--async"]);
    expect(parsed.async).toBe(true);
  });

  it("defaults async to undefined (off)", () => {
    const parsed = parseMcpServeArgs(["wf.ts"]);
    expect(parsed.async).toBeUndefined();
  });

  it("parses --job-ttl <ms>", () => {
    const parsed = parseMcpServeArgs([
      "wf.ts",
      "--async",
      "--job-ttl",
      "1800000",
    ]);
    expect(parsed.jobTtlMs).toBe(1_800_000);
  });

  it("parses --checkpoint-ttl <ms>", () => {
    const parsed = parseMcpServeArgs([
      "wf.ts",
      "--async",
      "--checkpoint-ttl",
      "900000",
    ]);
    expect(parsed.jobCheckpointTtlMs).toBe(900_000);
  });

  it("rejects --job-ttl with no value", () => {
    expect(() => parseMcpServeArgs(["wf.ts", "--async", "--job-ttl"])).toThrow(
      /requires/,
    );
  });

  it("rejects --job-ttl with non-positive value", () => {
    expect(() =>
      parseMcpServeArgs(["wf.ts", "--async", "--job-ttl", "0"]),
    ).toThrow(/positive/);
  });

  it("rejects TTL flags without --async", () => {
    expect(() => parseMcpServeArgs(["wf.ts", "--job-ttl", "1000"])).toThrow(
      /requires --async/,
    );
  });

  it("rejects --checkpoint-ttl without --async", () => {
    expect(() =>
      parseMcpServeArgs(["wf.ts", "--checkpoint-ttl", "1000"]),
    ).toThrow(/requires --async/);
  });
});
