import { describe, expect, it } from "vitest";
import { filterMcpTools, isMcpToolPermitted } from "../mcp-allowlist.js";

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
