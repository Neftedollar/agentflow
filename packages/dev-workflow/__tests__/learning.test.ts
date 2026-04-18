// Unit tests for the initLearning helper — verifies directory creation,
// hooks shape, and dbPath resolution without invoking the executor.
//
// SqliteLearningStore is mocked to avoid the bun:sqlite runtime dependency
// in the Vite/Vitest environment. The real store is tested in
// packages/learning-sqlite where bun --bun mode is available.

import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock @ageflow/learning-sqlite before importing the module under test ────

vi.mock("@ageflow/learning-sqlite", () => {
  class SqliteLearningStore {}
  return { SqliteLearningStore };
});

// ─── Mock @ageflow/learning so we control hooks shape ────────────────────────

vi.mock("@ageflow/learning", () => {
  const createLearningHooks = vi.fn().mockReturnValue({
    onWorkflowStart: vi.fn(),
    onTaskStart: vi.fn(),
    onTaskComplete: vi.fn(),
    onWorkflowComplete: vi.fn(),
  });
  return { createLearningHooks };
});

// Import after mocks are registered
const { initLearning } = await import("../shared/learning.js");

let scratchDir: string;

beforeEach(() => {
  scratchDir = join(tmpdir(), `dev-workflow-learning-test-${randomUUID()}`);
});

afterEach(() => {
  if (existsSync(scratchDir)) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

describe("initLearning", () => {
  it("creates the .ageflow directory if it does not exist", () => {
    const ageflowDir = join(scratchDir, ".ageflow");
    expect(existsSync(ageflowDir)).toBe(false);

    initLearning({ repoRoot: scratchDir, workflowName: "dev-workflow:test" });

    expect(existsSync(ageflowDir)).toBe(true);
  });

  it("returns a hooks object with the expected callbacks", () => {
    const { hooks } = initLearning({
      repoRoot: scratchDir,
      workflowName: "dev-workflow:test",
    });

    expect(typeof hooks.onWorkflowStart).toBe("function");
    expect(typeof hooks.onTaskStart).toBe("function");
    expect(typeof hooks.onWorkflowComplete).toBe("function");
    expect(typeof hooks.onTaskComplete).toBe("function");
  });

  it("returns dbPath under <repoRoot>/.ageflow/learning.sqlite", () => {
    const { dbPath } = initLearning({
      repoRoot: scratchDir,
      workflowName: "dev-workflow:feature",
    });

    const expected = join(scratchDir, ".ageflow", "learning.sqlite");
    expect(dbPath).toBe(expected);
  });
});
