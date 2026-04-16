import { AgentFlowError } from "@ageflow/core";

export class SessionCycleError extends AgentFlowError {
  readonly code = "session_cycle" as const;
  constructor(
    readonly cycle: string[],
    options?: ErrorOptions,
  ) {
    super(`Session reference cycle detected: ${cycle.join(" → ")}`, options);
  }
}

export class UnresolvedSessionRefError extends AgentFlowError {
  readonly code = "unresolved_session_ref" as const;
  constructor(
    readonly taskName: string,
    readonly targetTask: string,
    options?: ErrorOptions,
  ) {
    super(
      `Task "${taskName}" uses shareSessionWith("${targetTask}") but "${targetTask}" has no session`,
      options,
    );
  }
}

export class HitlNotInteractiveError extends AgentFlowError {
  readonly code = "hitl_not_interactive" as const;
  constructor(
    readonly taskName: string,
    options?: ErrorOptions,
  ) {
    super(
      `Task "${taskName}" requires HITL checkpoint but no TTY is available and no onCheckpoint hook approved. In headless mode, provide an onCheckpoint hook that returns true to approve.`,
      options,
    );
  }
}

export class OutputValidationError extends AgentFlowError {
  readonly code = "output_validation_error" as const;
  constructor(
    readonly taskName: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(
      `Output validation failed for task "${taskName}": ${reason}`,
      options,
    );
  }
}

export class UnresolvedDependencyError extends AgentFlowError {
  readonly code = "unresolved_dependency" as const;
  constructor(
    readonly taskName: string,
    readonly unresolvedDep: string,
    readonly availableTaskNames: string[],
    options?: ErrorOptions,
  ) {
    const available =
      availableTaskNames.length > 0
        ? ` Available tasks: ${availableTaskNames.join(", ")}.`
        : "";
    super(
      `Task "${taskName}" depends on "${unresolvedDep}" which does not exist in the workflow.${available}`,
      options,
    );
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
