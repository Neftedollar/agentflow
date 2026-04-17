/**
 * learn-feedback.test.ts
 *
 * Minimal tests that verify the learn and feedback command registration
 * does not throw and that the Command structure is correct.
 */

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerFeedbackCommand } from "../commands/feedback.js";
import { registerLearnCommand } from "../commands/learn.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.name("agentwf").description("test").version("0.0.0").exitOverride(); // prevent process.exit in tests
  return program;
}

// ─── learn command registration ───────────────────────────────────────────────

describe("registerLearnCommand", () => {
  it("registers without error", () => {
    const program = makeProgram();
    expect(() => registerLearnCommand(program)).not.toThrow();
  });

  it("adds 'learn' command to program", () => {
    const program = makeProgram();
    registerLearnCommand(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("learn");
  });

  it("learn has 'status' subcommand", () => {
    const program = makeProgram();
    registerLearnCommand(program);
    const learn = program.commands.find((c) => c.name() === "learn");
    expect(learn).toBeDefined();
    const subNames = learn?.commands.map((c) => c.name()) ?? [];
    expect(subNames).toContain("status");
  });

  it("learn has 'evaluate' subcommand", () => {
    const program = makeProgram();
    registerLearnCommand(program);
    const learn = program.commands.find((c) => c.name() === "learn");
    const subNames = learn?.commands.map((c) => c.name()) ?? [];
    expect(subNames).toContain("evaluate");
  });

  it("learn has 'promote' subcommand", () => {
    const program = makeProgram();
    registerLearnCommand(program);
    const learn = program.commands.find((c) => c.name() === "learn");
    const subNames = learn?.commands.map((c) => c.name()) ?? [];
    expect(subNames).toContain("promote");
  });

  it("learn has 'export' subcommand", () => {
    const program = makeProgram();
    registerLearnCommand(program);
    const learn = program.commands.find((c) => c.name() === "learn");
    const subNames = learn?.commands.map((c) => c.name()) ?? [];
    expect(subNames).toContain("export");
  });

  it("learn has 'import' subcommand", () => {
    const program = makeProgram();
    registerLearnCommand(program);
    const learn = program.commands.find((c) => c.name() === "learn");
    const subNames = learn?.commands.map((c) => c.name()) ?? [];
    expect(subNames).toContain("import");
  });

  it("learn status has a description", () => {
    const program = makeProgram();
    registerLearnCommand(program);
    const learn = program.commands.find((c) => c.name() === "learn");
    const status = learn?.commands.find((c) => c.name() === "status");
    expect(status?.description()).toBeTruthy();
  });

  it("learn export has --out option with default './skills'", () => {
    const program = makeProgram();
    registerLearnCommand(program);
    const learn = program.commands.find((c) => c.name() === "learn");
    const exportCmd = learn?.commands.find((c) => c.name() === "export");
    expect(exportCmd).toBeDefined();
    const outOption = exportCmd?.options.find((o) => o.long === "--out");
    expect(outOption).toBeDefined();
    expect(outOption?.defaultValue).toBe("./skills");
  });
});

// ─── feedback command registration ───────────────────────────────────────────

describe("registerFeedbackCommand", () => {
  it("registers without error", () => {
    const program = makeProgram();
    expect(() => registerFeedbackCommand(program)).not.toThrow();
  });

  it("adds 'feedback' command to program", () => {
    const program = makeProgram();
    registerFeedbackCommand(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("feedback");
  });

  it("feedback has --rating as required option", () => {
    const program = makeProgram();
    registerFeedbackCommand(program);
    const feedbackCmd = program.commands.find((c) => c.name() === "feedback");
    expect(feedbackCmd).toBeDefined();
    const ratingOption = feedbackCmd?.options.find(
      (o) => o.long === "--rating",
    );
    expect(ratingOption).toBeDefined();
    expect(ratingOption?.mandatory).toBe(true);
  });

  it("feedback has --comment as optional option", () => {
    const program = makeProgram();
    registerFeedbackCommand(program);
    const feedbackCmd = program.commands.find((c) => c.name() === "feedback");
    const commentOption = feedbackCmd?.options.find(
      (o) => o.long === "--comment",
    );
    expect(commentOption).toBeDefined();
    expect(commentOption?.mandatory).toBe(false);
  });

  it("feedback has --source option with default 'human'", () => {
    const program = makeProgram();
    registerFeedbackCommand(program);
    const feedbackCmd = program.commands.find((c) => c.name() === "feedback");
    const sourceOption = feedbackCmd?.options.find(
      (o) => o.long === "--source",
    );
    expect(sourceOption).toBeDefined();
    expect(sourceOption?.defaultValue).toBe("human");
  });

  it("feedback has a description mentioning trace", () => {
    const program = makeProgram();
    registerFeedbackCommand(program);
    const feedbackCmd = program.commands.find((c) => c.name() === "feedback");
    expect(feedbackCmd?.description().toLowerCase()).toContain("trace");
  });
});

// ─── bin.ts integration — both commands appear together ──────────────────────

describe("bin.ts command registration", () => {
  it("both learn and feedback can coexist on the same program", () => {
    const program = makeProgram();
    registerLearnCommand(program);
    registerFeedbackCommand(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("learn");
    expect(names).toContain("feedback");
  });
});
