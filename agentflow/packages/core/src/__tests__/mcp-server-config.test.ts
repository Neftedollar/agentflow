import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServerConfigSchema } from "../schemas.js";

describe("McpServerConfigSchema", () => {
  it("accepts a minimal config (name + command)", () => {
    const out = McpServerConfigSchema.parse({
      name: "filesystem",
      command: "npx",
    });
    expect(out.name).toBe("filesystem");
    expect(out.command).toBe("npx");
  });

  it("accepts args, env, cwd, tools, transport=stdio", () => {
    const out = McpServerConfigSchema.parse({
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" },
      cwd: "./workdir",
      tools: ["list_issues", "create_issue"],
      transport: "stdio",
    });
    expect(out.tools).toEqual(["list_issues", "create_issue"]);
  });

  it("rejects names with path separators", () => {
    expect(() =>
      McpServerConfigSchema.parse({ name: "file/system", command: "x" }),
    ).toThrow();
  });

  it("rejects names containing '__' (FQN delimiter)", () => {
    const result = McpServerConfigSchema.safeParse({
      name: "a__b",
      command: "x",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain(
      "MCP server name cannot contain '__' (reserved as FQN delimiter)",
    );
  });

  it("accepts single-underscore names like 'github_enterprise'", () => {
    const result = McpServerConfigSchema.safeParse({
      name: "github_enterprise",
      command: "npx",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown transport values", () => {
    expect(() =>
      McpServerConfigSchema.parse({
        name: "x",
        command: "y",
        transport: "http",
      }),
    ).toThrow();
  });

  it("rejects empty command", () => {
    expect(() =>
      McpServerConfigSchema.parse({ name: "x", command: "" }),
    ).toThrow();
  });

  it("accepts a refine map with Zod schema values (#84)", () => {
    const result = McpServerConfigSchema.safeParse({
      name: "filesystem",
      command: "npx",
      refine: { tool_name: z.object({ path: z.string() }) },
    });
    expect(result.success).toBe(true);
  });

  it("accepts refine as an empty object", () => {
    const result = McpServerConfigSchema.safeParse({
      name: "filesystem",
      command: "npx",
      refine: {},
    });
    expect(result.success).toBe(true);
  });
});
