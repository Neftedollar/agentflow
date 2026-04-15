import chalk from "chalk";

/**
 * Format a structured error for CLI output.
 * Returns the rendered string.
 */
export function formatCliError(
  message: string,
  detail?: string,
  hint?: string,
): string {
  const lines: string[] = [];

  lines.push(chalk.red.bold(`✗ ${message}`));

  if (detail !== undefined && detail.length > 0) {
    lines.push(chalk.dim(`  ${detail}`));
  }

  if (hint !== undefined && hint.length > 0) {
    lines.push(chalk.yellow(`  Hint: ${hint}`));
  }

  return lines.join("\n");
}

/**
 * Print a formatted CLI error to stderr and return the rendered string.
 */
export function printCliError(
  message: string,
  detail?: string,
  hint?: string,
): string {
  const output = formatCliError(message, detail, hint);
  process.stderr.write(output + "\n");
  return output;
}
