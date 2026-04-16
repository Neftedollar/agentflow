import { describe, expect, it } from "vitest";
import { resolveMcp } from "../resolve-mcp.js";

const fsSrv = { name: "filesystem", command: "npx" } as const;
const ghSrv = { name: "github", command: "npx" } as const;
const slackSrv = { name: "slack", command: "npx" } as const;

describe("resolveMcp", () => {
  it("returns [] when nothing configured", () => {
    expect(resolveMcp(undefined, undefined, undefined)).toEqual([]);
  });

  it("falls back to workflow servers when agent has no mcp", () => {
    const got = resolveMcp([fsSrv], undefined, undefined);
    expect(got.map((s) => s.name)).toEqual(["filesystem"]);
  });

  it("agent mcp REPLACES workflow by default", () => {
    const got = resolveMcp([fsSrv], { servers: [ghSrv] }, undefined);
    expect(got.map((s) => s.name)).toEqual(["github"]);
  });

  it("agent mcp with extendWorkflow=true APPENDS + dedupes", () => {
    const got = resolveMcp(
      [fsSrv, ghSrv],
      {
        servers: [{ ...ghSrv, tools: ["create_issue"] }, slackSrv],
        extendWorkflow: true,
      },
      undefined,
    );
    // agent wins on duplicate name
    expect(got.map((s) => s.name)).toEqual(["filesystem", "github", "slack"]);
    expect(got.find((s) => s.name === "github")?.tools).toEqual([
      "create_issue",
    ]);
  });

  it("task mcpOverride filters to the named subset", () => {
    const got = resolveMcp([fsSrv, ghSrv, slackSrv], undefined, {
      servers: ["slack"],
    });
    expect(got.map((s) => s.name)).toEqual(["slack"]);
  });

  it("unknown name in mcpOverride throws (pre-flight catches this earlier)", () => {
    expect(() =>
      resolveMcp([fsSrv], undefined, { servers: ["does-not-exist"] }),
    ).toThrow();
  });
});
