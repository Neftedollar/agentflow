#!/usr/bin/env node
import { program } from "commander";
import { registerDryRunCommand } from "./commands/dry-run.js";
import { registerInitCommand } from "./commands/init.js";
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

program.parse();
