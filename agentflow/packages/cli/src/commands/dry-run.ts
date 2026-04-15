import path from "node:path";
import { resolveAgentDef } from "@agentflow/core";
import type { AgentDef, TaskDef, TasksMap, WorkflowDef } from "@agentflow/core";
import { topologicalSort } from "@agentflow/executor";
import chalk from "chalk";
import type { Command } from "commander";
import { renderDryRunTask, renderError } from "../output/renderer.js";

export function registerDryRunCommand(program: Command): void {
  program
    .command("dry-run <workflow>")
    .description("Resolve the DAG and print prompts without running agents")
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

        process.stdout.write(
          chalk.bold(`Dry-run: ${workflow.name}`) +
            chalk.dim(` (${workflowFile})\n`),
        );

        // Resolve execution order via topological sort
        const batches = topologicalSort(workflow.tasks);

        process.stdout.write(
          chalk.dim(`\nExecution order: ${batches.length} batch(es)\n`),
        );

        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
          const batch = batches[batchIdx];
          if (batch === undefined) continue;

          process.stdout.write(
            chalk.dim(
              `\nBatch ${batchIdx + 1} [parallel]: ${batch.join(", ")}\n`,
            ),
          );

          for (const taskName of batch) {
            const taskDef = workflow.tasks[taskName];
            if (taskDef === undefined) continue;

            if ("kind" in taskDef) {
              // LoopDef
              process.stdout.write(
                `${
                  chalk.bold(`\n── Loop: ${taskName}`) +
                  chalk.dim(` (max: ${taskDef.max} iterations)`)
                }\n`,
              );
              renderDryRunInner(taskDef.tasks);
            } else {
              // biome-ignore lint/suspicious/noExplicitAny: structural constraint
              const task = taskDef as TaskDef<AgentDef<any, any, any>>;
              const resolved = resolveAgentDef(task.agent);
              const deps = task.dependsOn ?? [];

              // Build a representative prompt using a placeholder input
              let prompt: string;
              try {
                const placeholderInput = buildPlaceholder(task.agent.input);
                prompt = resolved.prompt(placeholderInput);
              } catch {
                prompt = chalk.dim(
                  "[prompt could not be rendered — depends on runtime context]",
                );
              }

              renderDryRunTask(taskName, resolved.runner, prompt, deps);
            }
          }
        }

        process.stdout.write("\n");
      } catch (err) {
        renderError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

/** Recursively print inner loop tasks */
function renderDryRunInner(tasks: TasksMap): void {
  const batches = topologicalSort(tasks);
  for (const batch of batches) {
    for (const taskName of batch) {
      const taskDef = tasks[taskName];
      if (taskDef === undefined) continue;

      if ("kind" in taskDef) {
        process.stdout.write(`${chalk.bold(`    ── Loop: ${taskName}`)}\n`);
        renderDryRunInner(taskDef.tasks);
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: structural constraint
        const task = taskDef as TaskDef<AgentDef<any, any, any>>;
        const resolved = resolveAgentDef(task.agent);
        const deps = task.dependsOn ?? [];

        let prompt: string;
        try {
          const placeholderInput = buildPlaceholder(task.agent.input);
          prompt = resolved.prompt(placeholderInput);
        } catch {
          prompt = chalk.dim(
            "[prompt could not be rendered — depends on runtime context]",
          );
        }

        renderDryRunTask(`  ${taskName}`, resolved.runner, prompt, deps);
      }
    }
  }
}

/**
 * Build a placeholder object from a Zod schema for prompt preview.
 * Produces "{field: <field>}" style objects for display purposes.
 */
function buildPlaceholder(
  schema: import("zod").ZodType,
): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: introspecting Zod internals
  const def = (schema as any)._def;
  if (def?.typeName === "ZodObject") {
    const shape = def.shape?.() ?? {};
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      result[key] = `<${key}>`;
    }
    return result;
  }
  return {};
}
