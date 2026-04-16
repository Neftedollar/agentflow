/**
 * mcp-serve.test.ts
 *
 * Unit tests for parseMcpServeArgs — pure argv parsing, no process or I/O.
 */

import { describe, expect, it } from "vitest";
import { parseMcpServeArgs } from "../commands/mcp-serve.js";

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
