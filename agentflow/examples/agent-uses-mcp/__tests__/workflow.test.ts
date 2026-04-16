/**
 * workflow.test.ts — Harness-based tests for the agent-uses-mcp example.
 *
 * Uses @ageflow/testing to mock the agent — no real CLI or API calls made.
 *
 * Key assertions:
 *   1. The DSL typechecks with all three runner values (api / claude / codex).
 *   2. The workflow graph is well-formed (single audit task, correct I/O).
 *   3. Mock output is forwarded correctly through the executor.
 */

import { defineWorkflow } from "@ageflow/core";
import { createTestHarness } from "@ageflow/testing";
import { describe, expect, it } from "vitest";
import { auditAgent } from "../agents/audit.js";
import { workflow } from "../workflow.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

const MOCK_OUTPUT = { summary: "Found 3 files in /tmp/workdir.", fileCount: 3 };

// ─── Main workflow (imported — uses default "api" runner) ─────────────────────

describe("agent-uses-mcp workflow (api runner)", () => {
  it("returns audit output via mock agent", async () => {
    const harness = createTestHarness(workflow);
    harness.mockAgent("audit", MOCK_OUTPUT);
    const res = await harness.run({});
    expect(res.outputs.audit).toEqual(MOCK_OUTPUT);
  });

  it("records call stats for the audit task", async () => {
    const harness = createTestHarness(workflow);
    harness.mockAgent("audit", MOCK_OUTPUT);
    await harness.run({});
    const stats = harness.getTask("audit");
    expect(stats.callCount).toBe(1);
    expect(stats.retryCount).toBe(0);
    expect(stats.outputs).toHaveLength(1);
  });
});

// ─── Same config under all three runner values ────────────────────────────────
//
// These tests prove that the auditAgent factory produces a well-typed AgentDef
// regardless of the runner string — the workflow DSL is runner-agnostic.

describe.each([["api" as const], ["claude" as const], ["codex" as const]])(
  "auditAgent with runner=%s",
  (r) => {
    it("typechecks and runs with mock harness", async () => {
      const wf = defineWorkflow({
        name: `agent-uses-mcp-demo-${r}`,
        tasks: {
          audit: {
            agent: auditAgent(r),
            input: { root: "/tmp/workdir" },
          },
        },
      });

      const harness = createTestHarness(wf);
      harness.mockAgent("audit", MOCK_OUTPUT);
      const res = await harness.run({});

      const out = res.outputs.audit as typeof MOCK_OUTPUT;
      expect(out.summary).toContain("3 files");
      expect(out.fileCount).toBe(3);
    });
  },
);

// ─── Workflow graph shape ─────────────────────────────────────────────────────

describe("workflow graph structure", () => {
  it("has exactly one task: audit", () => {
    expect(Object.keys(workflow.tasks)).toEqual(["audit"]);
  });

  it("audit task uses the correct runner (api by default in test env)", () => {
    const task = workflow.tasks.audit as { agent: { runner: string } };
    expect(["api", "claude", "codex"]).toContain(task.agent.runner);
  });

  it("audit task declares filesystem MCP server", () => {
    const task = workflow.tasks.audit as {
      agent: { mcp?: { servers?: ReadonlyArray<{ name: string }> } };
    };
    const servers = task.agent.mcp?.servers ?? [];
    expect(servers.some((s) => s.name === "filesystem")).toBe(true);
  });
});
