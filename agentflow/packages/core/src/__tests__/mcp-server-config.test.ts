import { describe, expect, it } from "vitest";
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
});
