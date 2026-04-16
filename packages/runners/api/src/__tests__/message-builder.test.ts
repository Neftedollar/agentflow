import { describe, expect, it } from "vitest";
import { buildInitialMessages } from "../message-builder.js";
import type { ChatMessage } from "../openai-types.js";

describe("buildInitialMessages", () => {
  it("user-only prompt with no system and no history", () => {
    const msgs = buildInitialMessages({
      prompt: "hi",
      systemPrompt: undefined,
      history: undefined,
    });
    expect(msgs).toEqual([{ role: "user", content: "hi" }]);
  });

  it("prepends system prompt when provided", () => {
    const msgs = buildInitialMessages({
      prompt: "hi",
      systemPrompt: "You are strict.",
      history: undefined,
    });
    expect(msgs[0]).toEqual({ role: "system", content: "You are strict." });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  it("appends user after existing history", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier answer" },
    ];
    const msgs = buildInitialMessages({
      prompt: "next",
      systemPrompt: undefined,
      history,
    });
    expect(msgs.length).toBe(4);
    expect(msgs[3]).toEqual({ role: "user", content: "next" });
  });

  it("P2-6: replaces stale system message with new systemPrompt on resumed sessions", () => {
    // Executor regenerates system prompt with per-task output schema on every
    // spawn. The new systemPrompt must replace the old one so stale schema
    // instructions do not persist across resumed sessions.
    const history: ChatMessage[] = [
      { role: "system", content: "old schema" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ];
    const msgs = buildInitialMessages({
      prompt: "next",
      systemPrompt: "new schema",
      history,
    });
    // Exactly one system message
    const systemMsgs = msgs.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBe(1);
    // Must be the NEW prompt, not the old one
    expect(systemMsgs[0]).toEqual({ role: "system", content: "new schema" });
    // Must appear first
    expect(msgs[0]).toEqual({ role: "system", content: "new schema" });
    // Old system message must be gone — remaining history preserved
    expect(msgs.filter((m) => m.content === "old schema").length).toBe(0);
    // User prompt is last
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "next" });
  });
});
