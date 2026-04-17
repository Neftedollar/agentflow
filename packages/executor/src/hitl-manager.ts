import * as readline from "node:readline";
import type { HITLConfig, InlineToolDef, WorkflowHooks } from "@ageflow/core";
import { HitlNotInteractiveError } from "./errors.js";

export class HITLManager {
  /**
   * Resolves effective HITLConfig for a task.
   * Task-level config takes precedence over agent-level.
   */
  resolveConfig(agentHitl?: HITLConfig, taskHitl?: HITLConfig): HITLConfig {
    return taskHitl ?? agentHitl ?? { mode: "off" };
  }

  /**
   * Apply permissions config to tools list.
   * Returns filtered tools array based on permission map.
   * Mode "permissions" uses deny-by-default: only explicitly `true` tools pass.
   *
   * Accepts both `readonly string[]` (legacy) and
   * `Readonly<Record<string, InlineToolDef>>` (inline map). When a map is
   * provided the keys are used as the tool name list for filtering.
   */
  applyPermissions(
    tools:
      | readonly string[]
      | Readonly<Record<string, InlineToolDef>>
      | undefined,
    config: HITLConfig,
  ): {
    tools: readonly string[] | undefined;
    permissions: Record<string, boolean> | undefined;
    /** true only when mode === "permissions" and the filter is actively enforced */
    enforcing: boolean;
  } {
    // Normalise tools to string[] for HITL filtering
    const toolNames: readonly string[] | undefined =
      tools === undefined
        ? undefined
        : Array.isArray(tools)
          ? (tools as readonly string[])
          : Object.keys(tools as Record<string, InlineToolDef>);

    if (config.mode !== "permissions") {
      return { tools: toolNames, permissions: undefined, enforcing: false };
    }
    const perms = config.permissions;
    const allowed = (toolNames ?? []).filter((t) => perms[t] === true);
    return {
      tools: allowed,
      permissions: Object.fromEntries(Object.entries(perms)),
      enforcing: true,
    };
  }

  /**
   * Run a checkpoint: notify via hook and optionally wait for TTY approval.
   * D2 contract:
   *   - Always calls hooks.onCheckpoint if defined (notification path — Telegram, Slack, etc.)
   *   - If hook returns Promise<boolean>: truthy = approved, skip TTY prompt
   *   - If no TTY and hook doesn't approve: throw HitlNotInteractiveError
   *   - If TTY: write "Press Enter to continue..." to stdout, wait for readline
   */
  async runCheckpoint(
    taskName: string,
    message: string,
    hooks: WorkflowHooks | undefined,
  ): Promise<void> {
    // Always call the hook if defined (notification path)
    let hookApproved = false;
    if (hooks?.onCheckpoint !== undefined) {
      // onCheckpoint: (taskName, message) => void | Promise<boolean | void>
      // Cast to extended signature that may return Promise<boolean | void>
      type CheckpointHookExtended = (
        taskName: string,
        message: string,
      ) => undefined | Promise<boolean | undefined>;
      const hookResult = (hooks.onCheckpoint as CheckpointHookExtended)(
        taskName,
        message,
      );
      // If the hook returns a Promise, await it to get veto/approval
      if (hookResult instanceof Promise) {
        const resolved = await hookResult;
        // Truthy resolution = approved
        if (resolved) {
          hookApproved = true;
        }
      }
      // void / synchronous return — not considered approval
    }

    if (hookApproved) {
      // Hook explicitly approved — no TTY prompt needed
      return;
    }

    // Check for TTY availability
    const isTTY = process.stdin.isTTY === true;

    if (!isTTY) {
      throw new HitlNotInteractiveError(taskName);
    }

    // TTY is available — prompt for user confirmation via readline
    await this._promptTTY(message);
  }

  private _promptTTY(message: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      process.stdout.write(
        `[AgentFlow HITL] ${message}\nPress Enter to continue...`,
      );
      rl.once("line", () => {
        rl.close();
        resolve();
      });
    });
  }
}
