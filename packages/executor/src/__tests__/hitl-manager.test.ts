import type { WorkflowHooks } from "@ageflow/core";
import { describe, expect, it, vi } from "vitest";
import { HitlNotInteractiveError } from "../errors.js";
import { HITLManager } from "../hitl-manager.js";

describe("HITLManager", () => {
  // ─── resolveConfig ─────────────────────────────────────────────────────────

  describe("resolveConfig", () => {
    const hm = new HITLManager();

    it("returns 'off' when neither agent nor task level config provided", () => {
      const config = hm.resolveConfig(undefined, undefined);
      expect(config).toEqual({ mode: "off" });
    });

    it("returns agent-level config when no task-level config", () => {
      const agentHitl = { mode: "checkpoint" as const };
      const config = hm.resolveConfig(agentHitl, undefined);
      expect(config).toEqual(agentHitl);
    });

    it("task-level config overrides agent-level config", () => {
      const agentHitl = { mode: "checkpoint" as const };
      const taskHitl = { mode: "off" as const };
      const config = hm.resolveConfig(agentHitl, taskHitl);
      expect(config).toEqual(taskHitl);
    });

    it("returns task-level permissions config", () => {
      const taskHitl = {
        mode: "permissions" as const,
        permissions: { bash: true, read: false },
      };
      const config = hm.resolveConfig(undefined, taskHitl);
      expect(config).toEqual(taskHitl);
    });
  });

  // ─── applyPermissions ──────────────────────────────────────────────────────

  describe("applyPermissions", () => {
    const hm = new HITLManager();

    it("mode 'off' → returns tools unchanged, no permissions, enforcing false", () => {
      const result = hm.applyPermissions(["bash", "read"], { mode: "off" });
      expect(result.tools).toEqual(["bash", "read"]);
      expect(result.permissions).toBeUndefined();
      expect(result.enforcing).toBe(false);
    });

    it("mode 'checkpoint' → returns tools unchanged, no permissions, enforcing false", () => {
      const result = hm.applyPermissions(["bash"], { mode: "checkpoint" });
      expect(result.tools).toEqual(["bash"]);
      expect(result.permissions).toBeUndefined();
      expect(result.enforcing).toBe(false);
    });

    it("mode 'permissions' with all allowed → returns all tools, enforcing true", () => {
      const result = hm.applyPermissions(["bash", "read", "write"], {
        mode: "permissions",
        permissions: { bash: true, read: true, write: true },
      });
      expect(result.tools).toEqual(["bash", "read", "write"]);
      expect(result.enforcing).toBe(true);
    });

    it("mode 'permissions' with deny → filters out denied tools, enforcing true", () => {
      const result = hm.applyPermissions(["bash", "read", "write"], {
        mode: "permissions",
        permissions: { bash: true, read: false, write: true },
      });
      expect(result.tools).toEqual(["bash", "write"]);
      expect(result.tools).not.toContain("read");
      expect(result.enforcing).toBe(true);
    });

    it("mode 'permissions' with empty tools → returns empty array, enforcing true", () => {
      const result = hm.applyPermissions(undefined, {
        mode: "permissions",
        permissions: { bash: true },
      });
      expect(result.tools).toEqual([]);
      expect(result.enforcing).toBe(true);
    });

    it("mode 'permissions' → returns permissions map", () => {
      const perms = { bash: true, read: false };
      const result = hm.applyPermissions(["bash"], {
        mode: "permissions",
        permissions: perms,
      });
      expect(result.permissions).toEqual(perms);
    });

    it("deny-by-default: tool not in permissions map is blocked", () => {
      // A tool not listed in the permissions map: perms[t] is undefined, undefined !== true → blocked
      const result = hm.applyPermissions(["bash", "unknown-tool"], {
        mode: "permissions",
        permissions: { bash: true },
      });
      // "unknown-tool" is not explicitly true, so it is denied
      expect(result.tools).not.toContain("unknown-tool");
      expect(result.tools).toContain("bash");
    });
  });

  // ─── runCheckpoint ─────────────────────────────────────────────────────────

  describe("runCheckpoint", () => {
    it("hook returns true → resolves without TTY check", async () => {
      const hm = new HITLManager();
      const hooks: WorkflowHooks = {
        onCheckpoint: vi
          .fn()
          .mockReturnValue(
            Promise.resolve(true),
          ) as WorkflowHooks["onCheckpoint"],
      };

      await expect(
        hm.runCheckpoint("my-task", "Approve?", hooks),
      ).resolves.toBeUndefined();
    });

    it("hook returns false → throws HitlNotInteractiveError (no TTY)", async () => {
      const hm = new HITLManager();
      const hooks: WorkflowHooks = {
        onCheckpoint: vi
          .fn()
          .mockReturnValue(
            Promise.resolve(false),
          ) as WorkflowHooks["onCheckpoint"],
      };

      // Ensure no TTY in test environment
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });

      try {
        await expect(
          hm.runCheckpoint("my-task", "Approve?", hooks),
        ).rejects.toThrow(HitlNotInteractiveError);
      } finally {
        if (originalIsTTY !== undefined) {
          Object.defineProperty(process.stdin, "isTTY", {
            value: originalIsTTY,
            configurable: true,
          });
        } else {
          Object.defineProperty(process.stdin, "isTTY", {
            value: undefined,
            configurable: true,
          });
        }
      }
    });

    it("hook returns void (synchronous) → not considered approval, throws if no TTY", async () => {
      const hm = new HITLManager();
      // Synchronous void return — not approval
      const hooks: WorkflowHooks = {
        onCheckpoint: vi
          .fn()
          .mockReturnValue(undefined) as WorkflowHooks["onCheckpoint"],
      };

      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });

      try {
        await expect(
          hm.runCheckpoint("my-task", "Approve?", hooks),
        ).rejects.toThrow(HitlNotInteractiveError);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: undefined,
          configurable: true,
        });
      }
    });

    it("no hook, no TTY → throws HitlNotInteractiveError", async () => {
      const hm = new HITLManager();

      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });

      try {
        await expect(
          hm.runCheckpoint("my-task", "Approve?", undefined),
        ).rejects.toThrow(HitlNotInteractiveError);
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: undefined,
          configurable: true,
        });
      }
    });

    it("HitlNotInteractiveError includes taskName", async () => {
      const hm = new HITLManager();
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });

      let caught: HitlNotInteractiveError | undefined;
      try {
        await hm.runCheckpoint("checkpoint-task", "Approve?", undefined);
      } catch (e) {
        if (e instanceof HitlNotInteractiveError) {
          caught = e;
        }
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: undefined,
          configurable: true,
        });
      }

      expect(caught?.taskName).toBe("checkpoint-task");
    });

    it("hook is always called (notification path) before TTY check", async () => {
      const hm = new HITLManager();
      const hookFn = vi.fn().mockResolvedValue(false);
      const hooks: WorkflowHooks = {
        onCheckpoint: hookFn as WorkflowHooks["onCheckpoint"],
      };

      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });

      try {
        await hm.runCheckpoint("my-task", "message", hooks).catch(() => {
          /* expected to throw */
        });
        expect(hookFn).toHaveBeenCalledWith("my-task", "message");
      } finally {
        Object.defineProperty(process.stdin, "isTTY", {
          value: undefined,
          configurable: true,
        });
      }
    });
  });
});
