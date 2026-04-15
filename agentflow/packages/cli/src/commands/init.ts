import path from "node:path";
import fs from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";
import { renderError } from "../output/renderer.js";

const WORKFLOW_TEMPLATE = `import { defineAgent, defineWorkflow } from "@agentflow/core";
import { z } from "zod";

// Register your runners before running the workflow:
// import { ClaudeRunner } from "@agentflow/runner-claude";
// registerRunner("claude", new ClaudeRunner());

const myAgent = defineAgent({
  runner: "claude",
  model: "claude-sonnet-4-6",
  input: z.object({
    message: z.string(),
  }),
  output: z.object({
    reply: z.string(),
  }),
  prompt: ({ message }) => \`Reply to: \${message}\`,
});

export default defineWorkflow({
  name: "WORKFLOW_NAME",
  tasks: {
    greet: {
      agent: myAgent,
      input: { message: "Hello, AgentFlow!" },
    },
  },
});
`;

export function registerInitCommand(program: Command): void {
  program
    .command("init <name>")
    .description("Scaffold a new workflow project")
    .action((name: string) => {
      try {
        // Validate name (simple identifier check)
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          renderError(
            `Invalid project name "${name}": use only letters, numbers, hyphens, and underscores`,
          );
          process.exit(1);
        }

        const projectDir = path.resolve(name);

        if (fs.existsSync(projectDir)) {
          renderError(
            `Directory "${name}" already exists. Choose a different name or remove the directory.`,
          );
          process.exit(1);
        }

        process.stdout.write(chalk.bold(`Scaffolding project: ${name}\n\n`));

        // Create project directory
        fs.mkdirSync(projectDir, { recursive: true });

        // Write workflow.ts
        const workflowContent = WORKFLOW_TEMPLATE.replace("WORKFLOW_NAME", name);
        fs.writeFileSync(path.join(projectDir, "workflow.ts"), workflowContent);

        // Write package.json
        const pkgJson = JSON.stringify(
          {
            name,
            version: "0.1.0",
            type: "module",
            scripts: {
              run: `agentwf run workflow.ts`,
              validate: `agentwf validate workflow.ts`,
              "dry-run": `agentwf dry-run workflow.ts`,
            },
            dependencies: {
              "@agentflow/core": "latest",
              "@agentflow/executor": "latest",
              "@agentflow/runner-claude": "latest",
              zod: "^3.23.0",
            },
          },
          null,
          2,
        );
        fs.writeFileSync(path.join(projectDir, "package.json"), pkgJson);

        process.stdout.write(chalk.green(`  ✓ ${name}/workflow.ts\n`));
        process.stdout.write(chalk.green(`  ✓ ${name}/package.json\n`));

        process.stdout.write(
          chalk.bold("\nNext steps:\n") +
          chalk.dim(`  cd ${name}\n`) +
          chalk.dim("  bun install\n") +
          chalk.dim("  agentwf validate workflow.ts\n") +
          chalk.dim("  agentwf run workflow.ts\n"),
        );
      } catch (err) {
        renderError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
