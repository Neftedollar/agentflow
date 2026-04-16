import { AgentFlowError } from "@ageflow/core";

export class CheckpointTimeoutError extends AgentFlowError {
  readonly code = "checkpoint_timeout" as const;
  constructor(
    readonly taskName: string,
    options?: ErrorOptions,
  ) {
    super(`Checkpoint for task "${taskName}" timed out`, options);
  }
}

export class RunNotFoundError extends AgentFlowError {
  readonly code = "run_not_found" as const;
  constructor(
    readonly runId: string,
    options?: ErrorOptions,
  ) {
    super(`Run not found: ${runId}`, options);
  }
}

export class InvalidRunStateError extends AgentFlowError {
  readonly code = "invalid_run_state" as const;
  constructor(
    readonly runId: string,
    readonly state: string,
    options?: ErrorOptions,
  ) {
    super(`Run ${runId} is in invalid state: ${state}`, options);
  }
}

export { HitlRejectedError } from "@ageflow/executor";
