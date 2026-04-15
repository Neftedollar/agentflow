import path from "node:path";
import type { WorkflowDef } from "@agentflow/core";
import { runPreflight } from "@agentflow/executor";
import chalk from "chalk";
import type { Command } from "commander";
import {
  renderError,
  renderValidationErrors,
  renderWarnings,
} from "../output/renderer.js";

export function registerValidateCommand(program: Command): void {
  program
    .command("validate <workflow>")
    .description("Validate a workflow file without running it")
    .action(async (workflowFile: string) => {
      try {
        const resolvedPath = path.resolve(workflowFile);

        let mod: Record<string, unknown>;
        try {
          mod = (await import(resolvedPath)) as Record<string, unknown>;
        } catch (importErr) {
          renderError(
            `Cannot import workflow file "${workflowFile}": ${importErr instanceof Error ? importErr.message : String(importErr)}`,
          );
          process.exit(1);
        }

        const workflow = (mod.default ?? mod.workflow) as
          | WorkflowDef
          | undefined;

        if (workflow === undefined || !("tasks" in workflow)) {
          renderError(
            "Invalid workflow file: must export a default WorkflowDef",
          );
          process.exit(1);
        }

        process.stdout.write(chalk.bold(`Validating: ${workflowFile}\n`));

        const result = await runPreflight(workflow);

        if (result.warnings.length > 0) {
          renderWarnings(result.warnings);
        }

        if (result.errors.length > 0) {
          renderValidationErrors(result.errors);
          process.stdout.write(
            chalk.red.bold(
              `\n✗ Validation failed (${result.errors.length} error(s))\n`,
            ),
          );
          process.exit(1);
        } else {
          process.stdout.write(chalk.green.bold("\n✓ Workflow is valid\n"));
        }
      } catch (err) {
        renderError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
