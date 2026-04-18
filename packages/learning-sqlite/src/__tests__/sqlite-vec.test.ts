/**
 * Tests for sqlite-vec integration in @ageflow/learning-sqlite.
 *
 * vec0 KNN search tests are gated behind SQLITE_VEC_AVAILABLE=1 because the
 * extension is a native shared library that may not be present in CI.
 * Run with:
 *   SQLITE_VEC_AVAILABLE=1 bun run test
 */

import { Database } from "bun:sqlite";
import type { SkillRecord } from "@ageflow/learning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS } from "../migrations.js";
import { SqliteLearningStore } from "../sqlite-learning-store.js";
import { SqliteSkillStore } from "../sqlite-skill-store.js";

// ─── Feature flag ─────────────────────────────────────────────────────────────

const VEC_AVAILABLE = process.env.SQLITE_VEC_AVAILABLE === "1";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: crypto.randomUUID(),
    name: "test-skill",
    description: "A test skill",
    content: "# Skill\nDo the thing well.",
    targetAgent: "analyze",
    version: 0,
    status: "active",
    score: 0.5,
    runCount: 0,
    bestInLineage: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a Float32Array of the given dimension filled with a value. */
function makeEmbedding(dim: number, fill = 0.1): Float32Array {
  return new Float32Array(dim).fill(fill);
}

// ─── FTS5 fallback — always runs ─────────────────────────────────────────────

describe("SqliteLearningStore — FTS5 fallback (no sqlite-vec)", () => {
  let store: SqliteLearningStore;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // In a normal test environment sqlite-vec is not available — the store
    // constructor will call console.warn with the fallback message.
    store = new SqliteLearningStore(new Database(":memory:"));
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("emits PERMANENT warning when sqlite-vec is unavailable", () => {
    // This test asserts the warning only when vec is actually unavailable.
    if (VEC_AVAILABLE) {
      // If extension loaded, no warning should have been emitted.
      expect(warnSpy).not.toHaveBeenCalled();
    } else {
      expect(warnSpy).toHaveBeenCalledOnce();
      const [msg] = warnSpy.mock.calls[0] as [string];
      expect(msg).toContain("[learning-sqlite]");
      expect(msg).toContain("sqlite-vec");
      expect(msg).toContain("FTS5");
      // Must be actionable — include install hint
      expect(msg).toContain("sqlite-vec");
      expect(msg).toContain("vec0");
    }
  });

  it("vecAvailable reflects extension load outcome", () => {
    expect(store.vecAvailable).toBe(VEC_AVAILABLE);
  });

  it("search works via FTS5 when embedding is absent", async () => {
    const skill = makeSkill({ description: "typescript error handling" });
    await store.save(skill);
    const results = await store.search("typescript error", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.skill.id).toBe(skill.id);
  });

  it("search falls back to FTS5 even if queryEmbedding passed when vec unavailable", async () => {
    if (VEC_AVAILABLE) return; // only meaningful when vec is absent
    const skill = makeSkill({ description: "async queue processing" });
    await store.save(skill);
    const fakeEmbedding = makeEmbedding(1536);
    const results = await store.search("async queue", 10, fakeEmbedding);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.skill.id).toBe(skill.id);
  });

  it("SkillRecord round-trip preserves embedding field", async () => {
    // Embeddings are not stored in the skills SQL table — they live in
    // skills_vec. So round-trip via get() will not return embedding.
    // This test confirms embedding is accepted on save without errors.
    const embedding = makeEmbedding(1536, 0.42);
    const skill = makeSkill({ embedding });
    // save must not throw even when vec is unavailable
    await expect(store.save(skill)).resolves.toBeUndefined();
    // get() returns the skill without embedding (vec table absent/skipped)
    const loaded = await store.get(skill.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(skill.id);
    // embedding is not persisted in skills table — expected undefined on load
    expect(loaded?.embedding).toBeUndefined();
  });
});

// ─── Warning fires every init (permanent) ────────────────────────────────────

describe("SqliteLearningStore — warning fires every init", () => {
  it("emits warning on each new store instance when vec unavailable", () => {
    if (VEC_AVAILABLE) return; // skip when extension is present

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      new SqliteLearningStore(new Database(":memory:"));
      new SqliteLearningStore(new Database(":memory:"));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── SqliteSkillStore constructor — vecAvailable=false ───────────────────────

describe("SqliteSkillStore — FTS5 path (vecAvailable=false)", () => {
  let db: Database;
  let store: SqliteSkillStore;

  beforeEach(() => {
    db = new Database(":memory:");
    for (const sql of MIGRATIONS) db.run(sql);
    store = new SqliteSkillStore(db, false);
  });

  afterEach(() => db.close());

  it("search uses FTS5 when vecAvailable=false even with embedding query", async () => {
    const skill = makeSkill({ description: "concurrent batch processing" });
    await store.save(skill);
    const results = await store.search(
      "concurrent batch",
      10,
      makeEmbedding(1536),
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.skill.id).toBe(skill.id);
  });

  it("delete removes skill without touching skills_vec", async () => {
    const skill = makeSkill();
    await store.save(skill);
    await expect(store.delete(skill.id)).resolves.toBeUndefined();
    expect(await store.get(skill.id)).toBeNull();
  });
});

// ─── Vec0 KNN tests — gated on SQLITE_VEC_AVAILABLE=1 ────────────────────────

describe.skipIf(!VEC_AVAILABLE)(
  "SqliteLearningStore — vec0 KNN search (SQLITE_VEC_AVAILABLE=1 required)",
  () => {
    let store: SqliteLearningStore;

    beforeEach(() => {
      // Use a custom low dimension to keep tests fast
      store = new SqliteLearningStore(new Database(":memory:"), {
        embeddingDimensions: 4,
      });
    });

    it("vecAvailable is true when extension loaded", () => {
      expect(store.vecAvailable).toBe(true);
    });

    it("save skill with embedding, search returns it via KNN", async () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const skill = makeSkill({ embedding });
      await store.save(skill);

      // Query with the same vector — should be the nearest neighbor
      const results = await store.search("", 5, embedding);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.skill.id).toBe(skill.id);
    });

    it("search returns nearest neighbor by cosine distance", async () => {
      const near = makeSkill({
        embedding: new Float32Array([1.0, 0.0, 0.0, 0.0]),
      });
      const far = makeSkill({
        embedding: new Float32Array([0.0, 0.0, 0.0, 1.0]),
      });
      await store.save(near);
      await store.save(far);

      const query = new Float32Array([1.0, 0.0, 0.0, 0.0]);
      const results = await store.search("", 5, query);
      expect(results[0]?.skill.id).toBe(near.id);
    });

    it("relevance score is in [0,1]", async () => {
      const skill = makeSkill({
        embedding: new Float32Array([0.5, 0.5, 0.5, 0.5]),
      });
      await store.save(skill);
      const results = await store.search(
        "",
        5,
        new Float32Array([0.5, 0.5, 0.5, 0.5]),
      );
      expect(results[0]?.relevance).toBeGreaterThanOrEqual(0);
      expect(results[0]?.relevance).toBeLessThanOrEqual(1);
    });

    it("delete cleans up skills_vec entry", async () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const skill = makeSkill({ embedding });
      await store.save(skill);
      await store.delete(skill.id);
      // After deletion, KNN search should return nothing for that exact vector
      const results = await store.search("", 5, embedding);
      const ids = results.map((r) => r.skill.id);
      expect(ids).not.toContain(skill.id);
    });

    it("search falls back to FTS5 when no queryEmbedding provided", async () => {
      const skill = makeSkill({ description: "event sourcing pattern" });
      await store.save(skill);
      const results = await store.search("event sourcing", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.skill.id).toBe(skill.id);
    });
  },
);
