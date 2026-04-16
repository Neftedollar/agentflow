import { describe, expect, it } from "vitest";
// Verify that ChatMessage is re-exported from the public API surface.
// This is a compile-time check: if ChatMessage is not exported, TypeScript
// will fail to compile this import and the test suite will not run.
import type { ChatMessage } from "../index.js";

describe("public API exports", () => {
  it("ChatMessage type is exported from index and usable as annotation", () => {
    const msg: ChatMessage = { role: "user", content: "hello" };
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello");
  });
});
