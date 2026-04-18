// Role-loader tests — assert every role file exists, parses cleanly, and
// the loader's async + sync entry points agree.

import { describe, expect, it } from "vitest";
import {
  _clearSyncCache,
  _rolesDir,
  loadRole,
  loadRoleSync,
  parseRoleMarkdown,
} from "../shared/role-loader.js";

const ROLES = [
  "product-manager",
  "engineering-software-architect",
  "engineering-senior-developer",
  "engineering-code-reviewer",
  "testing-reality-checker",
  "engineering-security-engineer",
  "ship",
] as const;

describe("role-loader", () => {
  it("exposes the roles directory path", () => {
    expect(_rolesDir).toContain("packages/dev-workflow/roles");
  });

  it("rejects invalid role names", async () => {
    await expect(loadRole("../etc/passwd")).rejects.toThrow(/invalid role/);
    await expect(loadRole("UPPERCASE")).rejects.toThrow(/invalid role/);
    await expect(loadRole("")).rejects.toThrow(/invalid role/);
    expect(() => loadRoleSync("../x")).toThrow(/invalid role/);
  });

  it("parses meta block + body", () => {
    const raw = [
      "# Example Role",
      "",
      "model-tier: strategic",
      "mission: one-line summary",
      "",
      "## Mission",
      "",
      "Body content goes here.",
    ].join("\n");
    const { meta, body } = parseRoleMarkdown(raw);
    expect(meta["model-tier"]).toBe("strategic");
    expect(meta.mission).toBe("one-line summary");
    // body is preserved verbatim — callers pass it to the agent prompt.
    expect(body).toBe(raw);
  });

  it("returns empty meta when no key:value block is present", () => {
    const raw = ["# Just A Heading", "", "Body only, no meta."].join("\n");
    const { meta, body } = parseRoleMarkdown(raw);
    expect(meta).toEqual({});
    expect(body).toBe(raw);
  });

  for (const name of ROLES) {
    it(`loads role "${name}" (async)`, async () => {
      const role = await loadRole(name);
      expect(role.name).toBe(name);
      expect(role.path).toMatch(new RegExp(`/roles/${name}\\.md$`));
      expect(role.body.trim().length).toBeGreaterThan(0);
      // Every role must declare a model tier for the orchestrator to
      // pick a model at spawn time. Strategic / execution / validation /
      // routine are the four tiers defined in root CLAUDE.md.
      expect(role.meta["model-tier"]).toMatch(
        /^(strategic|execution|validation|routine)$/,
      );
      expect(role.meta.mission?.length ?? 0).toBeGreaterThan(0);
    });

    it(`loads role "${name}" (sync)`, () => {
      _clearSyncCache();
      const role = loadRoleSync(name);
      expect(role.name).toBe(name);
      expect(role.body.trim().length).toBeGreaterThan(0);
      expect(role.meta["model-tier"]).toMatch(
        /^(strategic|execution|validation|routine)$/,
      );
    });
  }

  it("async + sync agree on body content for a sample role", async () => {
    _clearSyncCache();
    const async1 = await loadRole("ship");
    const sync1 = loadRoleSync("ship");
    expect(sync1.body).toBe(async1.body);
    expect(sync1.meta).toEqual(async1.meta);
  });

  it("sync cache returns the same object across calls", () => {
    _clearSyncCache();
    const a = loadRoleSync("ship");
    const b = loadRoleSync("ship");
    expect(a).toBe(b);
  });
});
