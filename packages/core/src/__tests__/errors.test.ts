import { describe, expect, it } from "vitest";
import {
  AgentFlowError,
  AgentHitlConflictError,
  BudgetExceededError,
  GenericAgentFlowError,
  LoopMaxIterationsError,
  McpServerStartFailedError,
  McpToolNotPermittedError,
  NodeMaxRetriesError,
  PathTraversalError,
  PreFlightError,
  SessionMismatchError,
  TimeoutError,
  ToolNotUsedError,
  ValidationError,
} from "../errors.js";

describe("AgentFlowError base class", () => {
  it("GenericAgentFlowError is instanceof Error and AgentFlowError", () => {
    const err = new GenericAgentFlowError("test", "test_code");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("fromJSON returns an AgentFlowError", () => {
    const err = AgentFlowError.fromJSON({ message: "test", code: "test_code" });
    expect(err).toBeInstanceOf(AgentFlowError);
    expect(err.message).toBe("test");
    expect(err.code).toBe("test_code");
  });
});

describe("NodeMaxRetriesError", () => {
  const attempts = [
    {
      attempt: 1,
      error: "subprocess failed",
      errorCode: "subprocess_error" as const,
    },
    {
      attempt: 2,
      error: "validation failed",
      errorCode: "output_validation_error" as const,
    },
  ];

  it("is instanceof Error and AgentFlowError", () => {
    const err = new NodeMaxRetriesError("myTask", attempts);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new NodeMaxRetriesError("myTask", attempts);
    expect(err.code).toBe("node_max_retries");
  });

  it("has readable message with taskName and attempt count", () => {
    const err = new NodeMaxRetriesError("myTask", attempts);
    expect(err.message).toContain("myTask");
    expect(err.message).toContain("2");
    expect(err.message).toContain("validation failed");
  });

  it("toJSON includes taskName and attempts", () => {
    const err = new NodeMaxRetriesError("myTask", attempts);
    const json = err.toJSON();
    expect(json.name).toBe("NodeMaxRetriesError");
    expect(json.code).toBe("node_max_retries");
    expect(json.message).toContain("myTask");
    expect(json.taskName).toBe("myTask");
    expect(json.attempts).toEqual(attempts);
  });
});

describe("LoopMaxIterationsError", () => {
  it("is instanceof Error and AgentFlowError", () => {
    const err = new LoopMaxIterationsError("fixLoop", 5);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new LoopMaxIterationsError("fixLoop", 5);
    expect(err.code).toBe("loop_max_iterations");
  });

  it("has readable message", () => {
    const err = new LoopMaxIterationsError("fixLoop", 5);
    expect(err.message).toContain("fixLoop");
    expect(err.message).toContain("5");
  });

  it("toJSON returns serializable object", () => {
    const err = new LoopMaxIterationsError("fixLoop", 5);
    const json = err.toJSON();
    expect(json.name).toBe("LoopMaxIterationsError");
    expect(json.code).toBe("loop_max_iterations");
    expect(json.message).toBeTruthy();
  });
});

describe("ToolNotUsedError", () => {
  it("is instanceof Error and AgentFlowError", () => {
    const err = new ToolNotUsedError("task1", ["bash", "edit"]);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new ToolNotUsedError("task1", ["bash"]);
    expect(err.code).toBe("tool_not_used");
  });

  it("includes required tools in message", () => {
    const err = new ToolNotUsedError("task1", ["bash", "edit"]);
    expect(err.message).toContain("bash");
    expect(err.message).toContain("edit");
  });
});

describe("BudgetExceededError", () => {
  it("is instanceof Error and AgentFlowError", () => {
    const err = new BudgetExceededError(10.0, 12.5);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new BudgetExceededError(10.0, 12.5);
    expect(err.code).toBe("budget_exceeded");
  });

  it("has readable message with costs", () => {
    const err = new BudgetExceededError(10.0, 12.5);
    expect(err.message).toContain("12.5000");
    expect(err.message).toContain("10.0000");
  });
});

describe("ValidationError", () => {
  it("is instanceof Error and AgentFlowError", () => {
    const err = new ValidationError("task1", "Expected string, got number");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new ValidationError("task1", "Expected string");
    expect(err.code).toBe("validation_error");
  });

  it("toJSON returns serializable object", () => {
    const err = new ValidationError("task1", "zod error details");
    const json = err.toJSON();
    expect(json.name).toBe("ValidationError");
    expect(json.code).toBe("validation_error");
    expect(typeof json.message).toBe("string");
  });
});

describe("AgentHitlConflictError", () => {
  it("is instanceof Error and AgentFlowError", () => {
    const err = new AgentHitlConflictError("task1");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new AgentHitlConflictError("task1");
    expect(err.code).toBe("agent_hitl_conflict");
  });
});

describe("PreFlightError", () => {
  it("is instanceof Error and AgentFlowError", () => {
    const err = new PreFlightError(["runner not found"], ["model deprecated"]);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new PreFlightError(["error1"], []);
    expect(err.code).toBe("pre_flight_error");
  });

  it("includes errors in message", () => {
    const err = new PreFlightError(
      ["runner not found", "budget invalid"],
      ["model deprecated"],
    );
    expect(err.message).toContain("runner not found");
    expect(err.message).toContain("budget invalid");
  });
});

describe("PathTraversalError", () => {
  it("is instanceof Error and AgentFlowError", () => {
    const err = new PathTraversalError("../secret", "traversal detected");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new PathTraversalError("../secret", "reason");
    expect(err.code).toBe("path_traversal");
  });

  it("carries .path and .reason", () => {
    const err = new PathTraversalError("../secret", "traversal detected");
    expect(err.path).toBe("../secret");
    expect(err.reason).toBe("traversal detected");
  });

  it("toJSON returns serializable object with name, code, message", () => {
    const err = new PathTraversalError("../secret", "traversal detected");
    const json = err.toJSON();
    expect(json.name).toBe("PathTraversalError");
    expect(json.code).toBe("path_traversal");
    expect(typeof json.message).toBe("string");
  });
});

describe("SessionMismatchError", () => {
  it("is instanceof Error and AgentFlowError", () => {
    const err = new SessionMismatchError("task1", "claude", "codex");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new SessionMismatchError("task1", "claude", "codex");
    expect(err.code).toBe("session_mismatch");
  });

  it("includes runner info in message", () => {
    const err = new SessionMismatchError("task1", "claude", "codex");
    expect(err.message).toContain("claude");
    expect(err.message).toContain("codex");
    expect(err.message).toContain("task1");
  });
});

describe("TimeoutError", () => {
  it("is instanceof Error and AgentFlowError", () => {
    const err = new TimeoutError("task1", 30_000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFlowError);
  });

  it("has correct code", () => {
    const err = new TimeoutError("task1", 30_000);
    expect(err.code).toBe("timeout");
  });

  it("includes task name and timeout in message", () => {
    const err = new TimeoutError("task1", 30_000);
    expect(err.message).toContain("task1");
    expect(err.message).toContain("30000");
  });
});

describe("MCP error hierarchy", () => {
  it("McpToolNotPermittedError carries server + tool names", () => {
    const err = new McpToolNotPermittedError("filesystem", "exec_anywhere");
    expect(err.code).toBe("mcp_tool_not_permitted");
    expect(err.message).toContain("filesystem/exec_anywhere");
  });

  it("McpServerStartFailedError is retriable (mcp_server_start_failed code)", () => {
    const err = new McpServerStartFailedError("github", "ENOENT");
    expect(err.code).toBe("mcp_server_start_failed");
    expect(["subprocess_error", "mcp_server_start_failed"]).toContain(err.code);
  });
});

describe("error instanceof chain", () => {
  it.each([
    ["NodeMaxRetriesError", new NodeMaxRetriesError("t", [])],
    ["LoopMaxIterationsError", new LoopMaxIterationsError("t", 1)],
    ["ToolNotUsedError", new ToolNotUsedError("t", [])],
    ["BudgetExceededError", new BudgetExceededError(1, 2)],
    ["ValidationError", new ValidationError("t", "err")],
    ["AgentHitlConflictError", new AgentHitlConflictError("t")],
    ["PreFlightError", new PreFlightError(["e"], [])],
    ["PathTraversalError", new PathTraversalError("p", "r")],
    ["SessionMismatchError", new SessionMismatchError("t", "a", "b")],
    ["TimeoutError", new TimeoutError("t", 1000)],
  ])("%s is instanceof AgentFlowError and Error", (_name, err) => {
    expect(err).toBeInstanceOf(AgentFlowError);
    expect(err).toBeInstanceOf(Error);
  });
});
