import { describe, expect, it } from "vitest";
import { computeDownstream } from "../dag-utils.js";

// ─── computeDownstream — DAG-based downstream detection ────────────────────────
//
// Tests cover the 4 cases specified in issue #174:
//   1. Parallel branches: a→c, b→d   → downstream(a)={c}, downstream(b)={d}
//   2. Linear chain:      a→b→c      → downstream(a)={b,c}
//   3. Diamond:           a→{b,c}→d  → downstream(a)={b,c,d}
//   4. Terminal task:     no dependents → empty set
// ──────────────────────────────────────────────────────────────────────────────

describe("computeDownstream — parallel branches", () => {
  // DAG: a → c, b → d  (c and d are independent; no cross-branch relationship)
  const dag: Record<string, readonly string[]> = {
    a: [],
    b: [],
    c: ["a"],
    d: ["b"],
  };

  it("downstream of a is {c} — NOT {c, d}", () => {
    const result = computeDownstream(dag, "a");
    expect(result.has("c")).toBe(true);
    expect(result.has("d")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("downstream of b is {d} — NOT {c, d}", () => {
    const result = computeDownstream(dag, "b");
    expect(result.has("d")).toBe(true);
    expect(result.has("c")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("downstream of c is empty (terminal)", () => {
    const result = computeDownstream(dag, "c");
    expect(result.size).toBe(0);
  });

  it("downstream of d is empty (terminal)", () => {
    const result = computeDownstream(dag, "d");
    expect(result.size).toBe(0);
  });
});

describe("computeDownstream — linear chain", () => {
  // DAG: a → b → c
  const dag: Record<string, readonly string[]> = {
    a: [],
    b: ["a"],
    c: ["b"],
  };

  it("downstream of a is {b, c}", () => {
    const result = computeDownstream(dag, "a");
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(true);
    expect(result.size).toBe(2);
  });

  it("downstream of b is {c} only", () => {
    const result = computeDownstream(dag, "b");
    expect(result.has("c")).toBe(true);
    expect(result.has("a")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("downstream of c (terminal) is empty", () => {
    const result = computeDownstream(dag, "c");
    expect(result.size).toBe(0);
  });
});

describe("computeDownstream — diamond", () => {
  // DAG: a → b, a → c, b → d, c → d
  const dag: Record<string, readonly string[]> = {
    a: [],
    b: ["a"],
    c: ["a"],
    d: ["b", "c"],
  };

  it("downstream of a is {b, c, d}", () => {
    const result = computeDownstream(dag, "a");
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(true);
    expect(result.has("d")).toBe(true);
    expect(result.size).toBe(3);
  });

  it("downstream of b is {d}", () => {
    const result = computeDownstream(dag, "b");
    expect(result.has("d")).toBe(true);
    expect(result.has("c")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("downstream of c is {d}", () => {
    const result = computeDownstream(dag, "c");
    expect(result.has("d")).toBe(true);
    expect(result.has("b")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("downstream of d (terminal) is empty", () => {
    const result = computeDownstream(dag, "d");
    expect(result.size).toBe(0);
  });
});

describe("computeDownstream — terminal task (no downstream)", () => {
  it("single-task workflow returns empty set", () => {
    const dag: Record<string, readonly string[]> = { only: [] };
    const result = computeDownstream(dag, "only");
    expect(result.size).toBe(0);
  });

  it("task not present in dag returns empty set", () => {
    const dag: Record<string, readonly string[]> = { a: [], b: ["a"] };
    const result = computeDownstream(dag, "unknown");
    expect(result.size).toBe(0);
  });
});
