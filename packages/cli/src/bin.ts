#!/usr/bin/env bun
import { program } from "commander";
import { registerDryRunCommand } from "./commands/dry-run.js";
import { registerFeedbackCommand } from "./commands/feedback.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLearnCommand } from "./commands/learn.js";
import { registerMcpCommand } from "./commands/mcp-serve.js";
import { registerRunCommand } from "./commands/run.js";
import { registerValidateCommand } from "./commands/validate.js";

program
  .name("agentwf")
  .description("AgentFlow CLI — run, validate, and scaffold AI agent workflows")
  .version("0.1.0");

registerRunCommand(program);
registerValidateCommand(program);
registerDryRunCommand(program);
registerInitCommand(program);
registerMcpCommand(program);
registerLearnCommand(program);
registerFeedbackCommand(program);

program.parse();
