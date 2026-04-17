import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../openai-types.js";
import { InMemorySessionStore } from "../session-store.js";

const msg: ChatMessage = { role: "user", content: "hello" };

describe("InMemorySessionStore", () => {
  it("returns undefined for unknown handles", async () => {
    const store = new InMemorySessionStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("round-trips messages via set/get", async () => {
    const store = new InMemorySessionStore();
    await store.set("h1", [msg]);
    expect(await store.get("h1")).toEqual([msg]);
  });

  it("isolates keys", async () => {
    const store = new InMemorySessionStore();
    await store.set("a", [msg]);
    await store.set("b", [{ role: "user", content: "other" }]);
    expect((await store.get("a"))?.[0]?.content).toBe("hello");
    expect((await store.get("b"))?.[0]?.content).toBe("other");
  });

  it("delete removes the handle", async () => {
    const store = new InMemorySessionStore();
    await store.set("gone", [msg]);
    await store.delete("gone");
    expect(await store.get("gone")).toBeUndefined();
  });

  it("stored snapshots are independent of the caller's array mutation", async () => {
    const store = new InMemorySessionStore();
    const live: ChatMessage[] = [msg];
    await store.set("h", live);
    live.push({ role: "user", content: "added after" });
    const got = await store.get("h");
    expect(got?.length).toBe(1);
  });
});
