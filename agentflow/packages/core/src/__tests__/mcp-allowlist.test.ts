import { describe, expect, it } from "vitest";
import {
  filterMcpTools,
  isMcpToolPermitted,
  parseMcpToolFqn,
} from "../mcp-allowlist.js";

describe("filterMcpTools (pre-dispatch)", () => {
  it("returns all tools when server.tools is undefined", () => {
    const got = filterMcpTools({ name: "fs", command: "x" }, [
      { name: "read" },
      { name: "write" },
    ]);
    expect(got.map((t) => t.name)).toEqual(["read", "write"]);
  });

  it("returns only allowlisted tools when server.tools is set", () => {
    const got = filterMcpTools({ name: "fs", command: "x", tools: ["read"] }, [
      { name: "read" },
      { name: "write" },
    ]);
    expect(got.map((t) => t.name)).toEqual(["read"]);
  });
});

describe("isMcpToolPermitted (post-dispatch)", () => {
  it("permits when allowlist is empty/undefined", () => {
    expect(isMcpToolPermitted({ name: "fs", command: "x" }, "read")).toBe(true);
  });
  it("permits only allowlisted tools", () => {
    const srv = { name: "fs", command: "x", tools: ["read"] } as const;
    expect(isMcpToolPermitted(srv, "read")).toBe(true);
    expect(isMcpToolPermitted(srv, "write")).toBe(false);
  });
});

describe("parseMcpToolFqn", () => {
  it("parses a simple server name without underscores", () => {
    expect(parseMcpToolFqn("mcp__simple__tool")).toEqual({
      server: "simple",
      tool: "tool",
    });
  });

  it("parses server names containing underscores (#84 regression)", () => {
    expect(parseMcpToolFqn("mcp__github_enterprise__list_issues")).toEqual({
      server: "github_enterprise",
      tool: "list_issues",
    });
  });

  it("parses server names with many underscores", () => {
    expect(
      parseMcpToolFqn("mcp__server_with_many_underscores__tool_name_here"),
    ).toEqual({
      server: "server_with_many_underscores",
      tool: "tool_name_here",
    });
  });

  it("returns undefined for non-MCP names", () => {
    expect(parseMcpToolFqn("not_an_fqn")).toBeUndefined();
  });

  it("returns undefined for strings missing the mcp__ prefix", () => {
    expect(parseMcpToolFqn("github_enterprise__list_issues")).toBeUndefined();
  });
});
