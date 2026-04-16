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

  it("P1-4: mutating a returned message object does not change stored history", async () => {
    // Shallow clone ([...messages]) does not deep-copy ChatMessage objects.
    // structuredClone must be used so in-place mutation of a returned message
    // cannot rewrite the stored history.
    const store = new InMemorySessionStore();
    const original: ChatMessage = { role: "user", content: "original" };
    await store.set("h2", [original]);

    // get() returns a deep copy; mutate it in place
    const returned = await store.get("h2");
    expect(returned).toBeDefined();
    if (returned?.[0]) {
      returned[0].content = "mutated";
    }

    // Re-get: stored history must be unchanged
    const reloaded = await store.get("h2");
    expect(reloaded?.[0]?.content).toBe("original");
  });

  it("P1-4: mutating the original array passed to set() does not change stored history", async () => {
    // Also verify that structuredClone is applied on set(), not just get()
    const store = new InMemorySessionStore();
    const msgs: ChatMessage[] = [{ role: "user", content: "before" }];
    await store.set("h3", msgs);

    // Mutate the original message object after set
    const m = msgs[0];
    if (m) m.content = "after";

    const stored = await store.get("h3");
    expect(stored?.[0]?.content).toBe("before");
  });
});
