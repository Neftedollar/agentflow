import { AgentFlowError } from "@agentflow/core";

export class OutputValidationError extends AgentFlowError {
  readonly code = "output_validation_error" as const;
  constructor(
    readonly taskName: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Output validation failed for task "${taskName}": ${reason}`, options);
  }
}

export class CyclicDependencyError extends AgentFlowError {
  readonly code = "cyclic_dependency" as const;
  constructor(
    readonly cycle: string[],
    options?: ErrorOptions,
  ) {
    super(`Cyclic dependency detected: ${cycle.join(" → ")}`, options);
  }
}

export class RunnerNotRegisteredError extends AgentFlowError {
  readonly code = "runner_not_registered" as const;
  constructor(
    readonly runnerName: string,
    options?: ErrorOptions,
  ) {
    super(
      `Runner "${runnerName}" is not registered. Call registerRunner() before running the workflow.`,
      options,
    );
  }
}
