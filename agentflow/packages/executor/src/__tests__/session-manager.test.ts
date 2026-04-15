import { defineAgent, sessionToken, shareSessionWith } from "@agentflow/core";
import type { TasksMap } from "@agentflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SessionCycleError, UnresolvedSessionRefError } from "../errors.js";
import { SessionManager } from "../session-manager.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const dummyAgent = defineAgent({
  runner: "claude",
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  prompt: () => "test",
});

function makeTask(
  session?:
    | ReturnType<typeof sessionToken>
    | ReturnType<typeof shareSessionWith>,
) {
  return {
    agent: dummyAgent,
    ...(session !== undefined ? { session } : {}),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionManager", () => {
  it("no sessions → all getHandle return undefined", () => {
    const tasks: TasksMap = {
      A: makeTask(),
      B: makeTask(),
    };
    const sm = new SessionManager(tasks);
    expect(sm.getHandle("A")).toBeUndefined();
    expect(sm.getHandle("B")).toBeUndefined();
  });

  it("SessionToken → canonical name is token.name", () => {
    const tok = sessionToken("my-session", "claude");
    const tasks: TasksMap = {
      A: makeTask(tok),
    };
    const sm = new SessionManager(tasks);
    expect(sm.canonicalToken("A")).toBe("my-session");
  });

  it("ShareSessionRef → resolves to target task's canonical token name", () => {
    const tok = sessionToken("shared-ctx", "claude");
    const tasks: TasksMap = {
      A: makeTask(tok),
      B: makeTask(shareSessionWith<TasksMap, "A">("A")),
    };
    const sm = new SessionManager(tasks);
    expect(sm.canonicalToken("A")).toBe("shared-ctx");
    expect(sm.canonicalToken("B")).toBe("shared-ctx");
  });

  it("transitive: A→B→C all resolve to C's canonical token", () => {
    const tok = sessionToken("root-token", "claude");
    const tasks: TasksMap = {
      C: makeTask(tok),
      B: makeTask(shareSessionWith<TasksMap, "C">("C")),
      A: makeTask(shareSessionWith<TasksMap, "B">("B")),
    };
    const sm = new SessionManager(tasks);
    expect(sm.canonicalToken("A")).toBe("root-token");
    expect(sm.canonicalToken("B")).toBe("root-token");
    expect(sm.canonicalToken("C")).toBe("root-token");
  });

  it("cycle A→B→A → throws SessionCycleError", () => {
    const tasks: TasksMap = {
      // A shares with B, B shares with A — cycle
      A: { agent: dummyAgent, session: { kind: "share", taskName: "B" } },
      B: { agent: dummyAgent, session: { kind: "share", taskName: "A" } },
    };
    expect(() => new SessionManager(tasks)).toThrow(SessionCycleError);
  });

  it("cycle error includes the cycle path", () => {
    const tasks: TasksMap = {
      A: { agent: dummyAgent, session: { kind: "share", taskName: "B" } },
      B: { agent: dummyAgent, session: { kind: "share", taskName: "A" } },
    };
    let caught: SessionCycleError | undefined;
    try {
      new SessionManager(tasks);
    } catch (e) {
      if (e instanceof SessionCycleError) {
        caught = e;
      }
    }
    expect(caught).toBeInstanceOf(SessionCycleError);
    expect(caught?.cycle.length).toBeGreaterThan(0);
  });

  it("ShareSessionRef pointing to task with no session → throws UnresolvedSessionRefError", () => {
    const tasks: TasksMap = {
      A: makeTask(), // no session
      B: { agent: dummyAgent, session: { kind: "share", taskName: "A" } },
    };
    expect(() => new SessionManager(tasks)).toThrow(UnresolvedSessionRefError);
  });

  it("UnresolvedSessionRefError includes taskName and targetTask", () => {
    const tasks: TasksMap = {
      A: makeTask(), // no session
      B: { agent: dummyAgent, session: { kind: "share", taskName: "A" } },
    };
    let caught: UnresolvedSessionRefError | undefined;
    try {
      new SessionManager(tasks);
    } catch (e) {
      if (e instanceof UnresolvedSessionRefError) {
        caught = e;
      }
    }
    expect(caught?.taskName).toBe("B");
    expect(caught?.targetTask).toBe("A");
  });

  it("setHandle + getHandle roundtrip", () => {
    const tok = sessionToken("tok1", "claude");
    const tasks: TasksMap = {
      A: makeTask(tok),
    };
    const sm = new SessionManager(tasks);

    // Before setting: undefined
    expect(sm.getHandle("A")).toBeUndefined();

    // Set a handle
    sm.setHandle("A", "sess-abc123");

    // After setting: returns the handle
    expect(sm.getHandle("A")).toBe("sess-abc123");
  });

  it("handles don't bleed across different tokens", () => {
    const tok1 = sessionToken("token-one", "claude");
    const tok2 = sessionToken("token-two", "claude");
    const tasks: TasksMap = {
      A: makeTask(tok1),
      B: makeTask(tok2),
    };
    const sm = new SessionManager(tasks);

    sm.setHandle("A", "handle-for-A");
    // B has a different token — should not see A's handle
    expect(sm.getHandle("B")).toBeUndefined();

    sm.setHandle("B", "handle-for-B");
    expect(sm.getHandle("A")).toBe("handle-for-A");
    expect(sm.getHandle("B")).toBe("handle-for-B");
  });

  it("tasks sharing the same token share the same handle", () => {
    const tok = sessionToken("shared", "claude");
    const tasks: TasksMap = {
      A: makeTask(tok),
      B: makeTask(tok),
    };
    const sm = new SessionManager(tasks);

    sm.setHandle("A", "shared-handle");
    // B shares the same token — should see the same handle
    expect(sm.getHandle("B")).toBe("shared-handle");
  });

  it("setHandle ignores empty string handles", () => {
    const tok = sessionToken("tok", "claude");
    const tasks: TasksMap = {
      A: makeTask(tok),
    };
    const sm = new SessionManager(tasks);

    sm.setHandle("A", "");
    expect(sm.getHandle("A")).toBeUndefined();
  });

  it("setHandleByToken + getHandleByToken roundtrip", () => {
    const sm = new SessionManager({});
    sm.setHandleByToken("custom-token", "handle-xyz");
    expect(sm.getHandleByToken("custom-token")).toBe("handle-xyz");
  });

  it("setHandleByToken ignores empty handles", () => {
    const sm = new SessionManager({});
    sm.setHandleByToken("custom-token", "");
    expect(sm.getHandleByToken("custom-token")).toBeUndefined();
  });
});
