import { describe, expect, it, vi } from "vitest";
import { ErrorCode, McpServerError } from "../errors.js";
import { buildMcpHooks } from "../hitl-bridge.js";

const mkConn = (supportsElicit: boolean, elicitResponse?: any) => ({
  supports: (cap: string) => cap === "elicitation" && supportsElicit,
  elicit: vi
    .fn()
    .mockResolvedValue(
      elicitResponse ?? { action: "accept", content: { approved: true } },
    ),
});

describe("buildMcpHooks", () => {
  it("hitl=auto always approves", async () => {
    const hooks = buildMcpHooks(mkConn(false), "auto", () => {}, undefined);
    const result = await hooks.onCheckpoint?.("verify", "approve?");
    expect(result).toBe(true);
  });

  it("hitl=fail always rejects", async () => {
    const hooks = buildMcpHooks(mkConn(true), "fail", () => {}, undefined);
    const result = await hooks.onCheckpoint?.("verify", "approve?");
    expect(result).toBe(false);
  });

  it("hitl=elicit + supported + accept+approved → true", async () => {
    const conn = mkConn(true, {
      action: "accept",
      content: { approved: true },
    });
    const hooks = buildMcpHooks(conn, "elicit", () => {}, undefined);
    expect(await hooks.onCheckpoint?.("verify", "approve?")).toBe(true);
    expect(conn.elicit).toHaveBeenCalled();
  });

  it("hitl=elicit + accept+approved:false → false", async () => {
    const conn = mkConn(true, {
      action: "accept",
      content: { approved: false },
    });
    const hooks = buildMcpHooks(conn, "elicit", () => {}, undefined);
    expect(await hooks.onCheckpoint?.("verify", "approve?")).toBe(false);
  });

  it("hitl=elicit + decline → false", async () => {
    const conn = mkConn(true, { action: "decline" });
    const hooks = buildMcpHooks(conn, "elicit", () => {}, undefined);
    expect(await hooks.onCheckpoint?.("verify", "approve?")).toBe(false);
  });

  it("hitl=elicit + cancel → throw HITL_CANCELLED", async () => {
    const conn = mkConn(true, { action: "cancel" });
    const hooks = buildMcpHooks(conn, "elicit", () => {}, undefined);
    await expect(hooks.onCheckpoint?.("verify", "approve?")).rejects.toThrow(
      /HITL_CANCELLED/,
    );
  });

  it("hitl=elicit + unsupported client → throw HITL_ELICITATION_UNSUPPORTED", async () => {
    const conn = mkConn(false);
    const hooks = buildMcpHooks(conn, "elicit", () => {}, undefined);
    await expect(hooks.onCheckpoint?.("verify", "approve?")).rejects.toThrow(
      /HITL_ELICITATION_UNSUPPORTED/,
    );
  });

  it("composes with user-provided onCheckpoint (user truthy short-circuits)", async () => {
    const conn = mkConn(true);
    const userHook = vi.fn().mockResolvedValue(true);
    const hooks = buildMcpHooks(conn, "elicit", () => {}, userHook);
    expect(await hooks.onCheckpoint?.("verify", "approve?")).toBe(true);
    expect(userHook).toHaveBeenCalledWith("verify", "approve?");
    expect(conn.elicit).not.toHaveBeenCalled();
  });

  it("falls through to elicitation when user hook doesn't approve", async () => {
    const conn = mkConn(true);
    const userHook = vi.fn().mockResolvedValue(undefined);
    const hooks = buildMcpHooks(conn, "elicit", () => {}, userHook);
    await hooks.onCheckpoint?.("verify", "approve?");
    expect(conn.elicit).toHaveBeenCalled();
  });
});
