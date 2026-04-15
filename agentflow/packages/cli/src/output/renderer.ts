import type { TaskMetrics, WorkflowMetrics } from "@ageflow/core";
import chalk from "chalk";

// ─── Header ───────────────────────────────────────────────────────────────────

/**
 * Render the top-level CLI header box.
 * Returns the string AND prints to stdout.
 */
export function renderHeader(command: string, workflowFile: string): string {
  const label = `Workflow: ${workflowFile}  Command: ${command}`;
  const width = Math.max(40, label.length + 4);
  const border = "─".repeat(width - 2);
  const padded = label.padEnd(width - 4);

  const lines = [
    chalk.cyan(`┌─ AgentFlow ${"─".repeat(width - 14)}┐`),
    `${chalk.cyan("│")} ${padded} ${chalk.cyan("│")}`,
    chalk.cyan(`└${border}┘`),
  ];

  const output = lines.join("\n");
  process.stdout.write(`${output}\n`);
  return output;
}

// ─── Pre-flight ───────────────────────────────────────────────────────────────

export function renderPreflightOk(runnerName: string): void {
  process.stdout.write(chalk.green(`[pre-flight] ✓ ${runnerName}\n`));
}

export function renderPreflightError(runnerName: string, error: string): void {
  process.stdout.write(chalk.red(`[pre-flight] ✗ ${runnerName}: ${error}\n`));
}

// ─── Task progress ────────────────────────────────────────────────────────────

export function renderTaskStart(taskName: string): void {
  process.stdout.write(chalk.yellow(`  ● ${taskName}  running...\n`));
}

/**
 * Render task completion line with timing, token counts, and estimated cost.
 * Returns the rendered string for test assertions.
 */
export function renderTaskComplete(
  taskName: string,
  metrics: TaskMetrics,
): string {
  const latencySec = (metrics.latencyMs / 1000).toFixed(1);
  const cost =
    metrics.estimatedCost > 0
      ? chalk.dim(` · $${metrics.estimatedCost.toFixed(4)}`)
      : "";

  const line =
    chalk.green(`  ✓ ${taskName}`) +
    chalk.dim(
      `  ${latencySec}s · ${metrics.tokensIn}/${metrics.tokensOut} tok`,
    ) +
    cost;

  process.stdout.write(`${line}\n`);
  return line;
}

export function renderTaskError(taskName: string, error: Error): void {
  process.stdout.write(
    `${chalk.red(`  ✗ ${taskName}`) + chalk.dim(`  ${error.message}`)}\n`,
  );
}

// ─── Workflow complete ────────────────────────────────────────────────────────

/**
 * Render the final workflow summary.
 * Returns the rendered string for test assertions.
 */
export function renderWorkflowComplete(metrics: WorkflowMetrics): string {
  const latencySec = (metrics.totalLatencyMs / 1000).toFixed(2);
  const cost =
    metrics.totalEstimatedCost > 0
      ? `  $${metrics.totalEstimatedCost.toFixed(4)}`
      : "";

  const line =
    chalk.bold.green("\n✓ Workflow complete") +
    chalk.dim(
      `  ${metrics.taskCount} tasks · ${latencySec}s · ` +
        `${metrics.totalTokensIn}/${metrics.totalTokensOut} tok${cost}`,
    );

  process.stdout.write(`${line}\n`);
  return line;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Render a fatal error message.
 * Returns the rendered string for test assertions.
 */
export function renderError(message: string): string {
  const line = chalk.red(`\n✗ Error: ${message}`);
  process.stderr.write(`${line}\n`);
  return line;
}

export function renderWarnings(warnings: string[]): void {
  for (const w of warnings) {
    process.stdout.write(chalk.yellow(`  ⚠ ${w}\n`));
  }
}

export function renderValidationErrors(errors: string[]): void {
  for (const e of errors) {
    process.stdout.write(chalk.red(`  ✗ ${e}\n`));
  }
}

export function renderDryRunTask(
  taskName: string,
  runnerName: string,
  prompt: string,
  deps: readonly string[],
  outputShape?: unknown,
): void {
  const depStr = deps.length > 0 ? ` (depends on: ${deps.join(", ")})` : "";
  process.stdout.write(
    `${
      chalk.bold(`\n── Task: ${taskName}`) +
      chalk.dim(` [${runnerName}]${depStr}`)
    }\n`,
  );
  process.stdout.write(`${chalk.dim("Prompt:\n") + prompt}\n`);
  if (outputShape !== undefined) {
    process.stdout.write(
      chalk.dim("Output shape:\n") +
        chalk.dim(JSON.stringify(outputShape, null, 2)) +
        "\n",
    );
  }
}
