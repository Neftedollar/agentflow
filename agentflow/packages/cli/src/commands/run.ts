import path from "node:path";
import type {
  TaskMetrics,
  WorkflowDef,
  WorkflowMetrics,
} from "@ageflow/core";
import { WorkflowExecutor } from "@ageflow/executor";
import type { Command } from "commander";
import {
  renderError,
  renderHeader,
  renderTaskComplete,
  renderTaskError,
  renderTaskStart,
  renderWorkflowComplete,
} from "../output/renderer.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run <workflow>")
    .description("Run a workflow file")
    .action(async (workflowFile: string) => {
      try {
        renderHeader("run", workflowFile);

        // Resolve path relative to cwd
        const resolvedPath = path.resolve(workflowFile);

        // Dynamic import of workflow file (ESM)
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
            `Invalid workflow file: must export a default WorkflowDef (found: ${typeof (mod.default ?? mod.workflow)})`,
          );
          process.exit(1);
        }

        // Merge progress hooks
        const existingHooks = workflow.hooks;
        const hooks = {
          ...existingHooks,
          onTaskStart: (taskName: string) => {
            renderTaskStart(taskName);
            existingHooks?.onTaskStart?.(taskName as never);
          },
          onTaskComplete: (
            taskName: string,
            output: unknown,
            metrics: TaskMetrics,
          ) => {
            renderTaskComplete(taskName, metrics);
            existingHooks?.onTaskComplete?.(taskName as never, output, metrics);
          },
          onTaskError: (taskName: string, error: Error, latencyMs: number) => {
            renderTaskError(taskName, error);
            existingHooks?.onTaskError?.(taskName as never, error, latencyMs);
          },
          onWorkflowComplete: (result: unknown, summary: WorkflowMetrics) => {
            renderWorkflowComplete(summary);
            existingHooks?.onWorkflowComplete?.(result, summary);
          },
        };

        const executor = new WorkflowExecutor({ ...workflow, hooks });
        await executor.run();
      } catch (err) {
        renderError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
