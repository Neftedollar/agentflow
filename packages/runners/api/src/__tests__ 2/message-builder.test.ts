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

  it("does not duplicate system when history already has one", () => {
    const history: ChatMessage[] = [{ role: "system", content: "old" }];
    const msgs = buildInitialMessages({
      prompt: "p",
      systemPrompt: "new",
      history,
    });
    // history wins — new systemPrompt only prepended if history has no system
    expect(msgs.filter((m) => m.role === "system").length).toBe(1);
    expect(msgs[0]).toEqual({ role: "system", content: "old" });
  });
});
