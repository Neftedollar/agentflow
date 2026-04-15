import type { TaskMetrics, WorkflowMetrics } from "@agentflow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliError } from "../output/errors.js";
import {
  renderError,
  renderHeader,
  renderPreflightError,
  renderPreflightOk,
  renderTaskComplete,
  renderTaskError,
  renderTaskStart,
  renderValidationErrors,
  renderWarnings,
  renderWorkflowComplete,
} from "../output/renderer.js";

// ─── Silence stdout/stderr during tests ───────────────────────────────────────

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("renderHeader", () => {
  it("returns a string containing the workflow name", () => {
    const output = renderHeader("run", "my-workflow.ts");
    expect(output).toContain("my-workflow.ts");
  });

  it("returns a string containing the command", () => {
    const output = renderHeader("validate", "workflow.ts");
    expect(output).toContain("validate");
  });

  it("writes to stdout", () => {
    renderHeader("run", "my-workflow.ts");
    expect(stdoutSpy).toHaveBeenCalled();
  });
});

describe("renderTaskComplete", () => {
  it("includes the task name", () => {
    const metrics: TaskMetrics = {
      tokensIn: 1240,
      tokensOut: 380,
      latencyMs: 4200,
      retries: 0,
      estimatedCost: 0.018,
    };
    const output = renderTaskComplete("analyze", metrics);
    expect(output).toContain("analyze");
  });

  it("includes token counts", () => {
    const metrics: TaskMetrics = {
      tokensIn: 1240,
      tokensOut: 380,
      latencyMs: 4200,
      retries: 0,
      estimatedCost: 0.018,
    };
    const output = renderTaskComplete("analyze", metrics);
    expect(output).toContain("1240");
    expect(output).toContain("380");
  });

  it("includes timing in seconds", () => {
    const metrics: TaskMetrics = {
      tokensIn: 100,
      tokensOut: 50,
      latencyMs: 4200,
      retries: 0,
      estimatedCost: 0,
    };
    const output = renderTaskComplete("task", metrics);
    expect(output).toContain("4.2s");
  });

  it("includes estimated cost when non-zero", () => {
    const metrics: TaskMetrics = {
      tokensIn: 100,
      tokensOut: 50,
      latencyMs: 1000,
      retries: 0,
      estimatedCost: 0.0123,
    };
    const output = renderTaskComplete("task", metrics);
    expect(output).toContain("0.0123");
  });

  it("writes to stdout", () => {
    const metrics: TaskMetrics = {
      tokensIn: 10,
      tokensOut: 20,
      latencyMs: 100,
      retries: 0,
      estimatedCost: 0,
    };
    renderTaskComplete("task", metrics);
    expect(stdoutSpy).toHaveBeenCalled();
  });
});

describe("renderWorkflowComplete", () => {
  it("returns a string containing task count", () => {
    const metrics: WorkflowMetrics = {
      totalLatencyMs: 8500,
      totalTokensIn: 2480,
      totalTokensOut: 760,
      totalEstimatedCost: 0.036,
      taskCount: 3,
    };
    const output = renderWorkflowComplete(metrics);
    expect(output).toContain("3 tasks");
  });

  it("includes total timing", () => {
    const metrics: WorkflowMetrics = {
      totalLatencyMs: 8500,
      totalTokensIn: 2480,
      totalTokensOut: 760,
      totalEstimatedCost: 0,
      taskCount: 2,
    };
    const output = renderWorkflowComplete(metrics);
    expect(output).toContain("8.50s");
  });

  it("writes to stdout", () => {
    const metrics: WorkflowMetrics = {
      totalLatencyMs: 1000,
      totalTokensIn: 10,
      totalTokensOut: 20,
      totalEstimatedCost: 0,
      taskCount: 1,
    };
    renderWorkflowComplete(metrics);
    expect(stdoutSpy).toHaveBeenCalled();
  });
});

describe("renderError", () => {
  it("returns a string containing the error message", () => {
    const output = renderError("Something went wrong");
    expect(output).toContain("Something went wrong");
  });

  it("writes to stderr", () => {
    renderError("fatal error");
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("includes 'Error' label", () => {
    const output = renderError("failed to connect");
    expect(output).toContain("Error");
  });
});

describe("renderTaskStart", () => {
  it("writes the task name to stdout", () => {
    renderTaskStart("myTask");
    const written = (stdoutSpy.mock.calls[0]?.[0] as string) ?? "";
    expect(written).toContain("myTask");
  });
});

describe("renderPreflightOk", () => {
  it("writes the runner name to stdout", () => {
    renderPreflightOk("claude");
    const written = (stdoutSpy.mock.calls[0]?.[0] as string) ?? "";
    expect(written).toContain("claude");
  });
});

describe("renderPreflightError", () => {
  it("writes runner name and error message to stdout", () => {
    renderPreflightError("codex", "binary not found");
    const written = (stdoutSpy.mock.calls[0]?.[0] as string) ?? "";
    expect(written).toContain("codex");
    expect(written).toContain("binary not found");
  });
});

describe("renderTaskError", () => {
  it("writes the task name and error message to stdout", () => {
    renderTaskError("analyze", new Error("subprocess crashed"));
    const written = (stdoutSpy.mock.calls[0]?.[0] as string) ?? "";
    expect(written).toContain("analyze");
    expect(written).toContain("subprocess crashed");
  });
});

describe("renderWarnings", () => {
  it("writes each warning to stdout", () => {
    renderWarnings(["warn1", "warn2"]);
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(written).toContain("warn1");
    expect(written).toContain("warn2");
  });
});

describe("renderValidationErrors", () => {
  it("writes each error to stdout", () => {
    renderValidationErrors(["err1", "err2"]);
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(written).toContain("err1");
    expect(written).toContain("err2");
  });
});

describe("formatCliError", () => {
  it("includes the main message", () => {
    const output = formatCliError("Main error");
    expect(output).toContain("Main error");
  });

  it("includes detail when provided", () => {
    const output = formatCliError("Main error", "detail info");
    expect(output).toContain("detail info");
  });

  it("includes hint when provided", () => {
    const output = formatCliError("Main error", undefined, "try --help");
    expect(output).toContain("try --help");
  });

  it("returns a string without writing to stdout/stderr directly", () => {
    formatCliError("error");
    // formatCliError does NOT call process.stderr.write — only printCliError does
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
