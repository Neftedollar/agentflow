export interface ProgressPayload {
  readonly progressToken: string | number;
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
  readonly meta: Record<string, unknown>;
}

export type SendProgress = (payload: ProgressPayload) => void;

/**
 * Bridges ageflow workflow events to MCP `notifications/progress`.
 *
 * If the client did not supply a progressToken (via _meta.progressToken),
 * all methods become no-ops — clients that didn't ask for progress should not receive it.
 */
export class ProgressStreamer {
  private counter = 0;

  constructor(
    private readonly send: SendProgress,
    private readonly progressToken: string | number | undefined,
  ) {}

  taskStarted(task: string): void {
    this.emit("task_started", { task });
  }

  taskCompleted(task: string, metrics: Record<string, unknown>): void {
    this.emit("task_completed", { task, metrics });
  }

  taskFailed(task: string, error: string): void {
    this.emit("task_failed", { task, error });
  }

  loopIteration(iteration: number): void {
    this.emit("loop_iteration", { iteration });
  }

  budgetWarning(spent: number, limit: number): void {
    this.emit("budget_warning", { spent, limit });
  }

  awaitingElicitation(task: string, message: string): void {
    this.emit("awaiting_elicitation", { task, message });
  }

  unlimitedWarning(axes: readonly string[]): void {
    this.emit("unlimited_warning", { axes });
  }

  private emit(phase: string, extra: Record<string, unknown>): void {
    if (this.progressToken === undefined) return;
    const progress = this.counter;
    this.counter += 1;
    this.send({
      progressToken: this.progressToken,
      progress,
      message: `${phase}: ${JSON.stringify(extra)}`,
      meta: { phase, ...extra },
    });
  }
}
