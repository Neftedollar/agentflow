import type { WorkflowHooks } from "@ageflow/core";
import { ErrorCode, McpServerError } from "./errors.js";
import type { HitlStrategy } from "./types.js";

export interface McpConnectionLike {
  supports(capability: "elicitation" | "progress"): boolean;
  elicit(req: {
    message: string;
    requestedSchema: Record<string, unknown>;
  }): Promise<ElicitationResponse>;
}

export interface ElicitationResponse {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
}

type OnAwaitingFn = (task: string, message: string) => void;
type UserHook = NonNullable<WorkflowHooks["onCheckpoint"]>;

/**
 * Build a WorkflowHooks object that routes HITL checkpoints to MCP elicitation.
 *
 * Strategy semantics:
 * - "auto": always approve (emits unlimited-style warning upstream if workflow has HITL)
 * - "fail": always reject → executor raises HitlNotInteractiveError
 * - "elicit": send elicitation/create to client, map response to approval
 *
 * If a user-provided `onCheckpoint` hook exists, call it FIRST. If it returns
 * truthy, short-circuit approve. Otherwise fall through to the MCP strategy.
 */
export function buildMcpHooks(
  conn: McpConnectionLike,
  strategy: HitlStrategy,
  emitAwaiting: OnAwaitingFn,
  userOnCheckpoint: UserHook | undefined,
): WorkflowHooks {
  return {
    onCheckpoint: async (taskName, message) => {
      // Compose: user hook first
      if (userOnCheckpoint !== undefined) {
        const userResult = await Promise.resolve(
          userOnCheckpoint(taskName, message) as unknown as Promise<
            boolean | undefined | undefined
          >,
        );
        if (userResult === true) return true as unknown as undefined;
      }

      // MCP strategy
      switch (strategy) {
        case "auto":
          return true as unknown as undefined;
        case "fail":
          return false as unknown as undefined;
        case "elicit": {
          if (!conn.supports("elicitation")) {
            throw new McpServerError(
              ErrorCode.HITL_ELICITATION_UNSUPPORTED,
              `HITL_ELICITATION_UNSUPPORTED: [${taskName}] client does not support elicitation; HITL checkpoint cannot be resolved`,
              { task: taskName },
            );
          }
          emitAwaiting(taskName, message);
          const response = await conn.elicit({
            message: `[${taskName}] ${message}`,
            requestedSchema: {
              type: "object",
              properties: {
                approved: {
                  type: "boolean",
                  description: "Approve to continue",
                },
                note: { type: "string", description: "Optional comment" },
              },
              required: ["approved"],
            },
          });

          if (response.action === "cancel") {
            throw new McpServerError(
              ErrorCode.HITL_CANCELLED,
              `HITL_CANCELLED: [${taskName}] HITL dialog cancelled by client`,
              { task: taskName },
            );
          }
          if (response.action === "decline") {
            return false as unknown as undefined;
          }
          // action === "accept"
          return (response.content?.approved === true) as unknown as undefined;
        }
      }
    },
  };
}
