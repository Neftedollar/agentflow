import { defineAgent, defineWorkflow } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type RunWorkflowFn, createMcpServer } from "../../server.js";

describe("createMcpServer (integration)", () => {
  const greetAgent = defineAgent({
    runner: "claude",
    model: "claude-sonnet-4-6",
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string() }),
    prompt: ({ name }) => `say hi to ${name}`,
  });

  const workflow = defineWorkflow({
    name: "greet",
    mcp: { description: "Greet someone", maxCostUsd: 0.5 },
    tasks: { greet: { agent: greetAgent } },
  });

  it("lists the workflow as a single tool", async () => {
    const server = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "fail",
    });
    const tools = await server.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("greet");
    expect(tools[0]?.description).toBe("Greet someone");
  });

  it("rejects call with invalid input", async () => {
    const server = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "fail",
    });
    const result = await server.callTool("greet", { name: 123 });
    expect(result.isError).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: accessing untyped structuredContent in test assertion
    expect((result.structuredContent as any).errorCode).toBe(
      "INPUT_VALIDATION_FAILED",
    );
  });

  it("returns BUSY when a call is already in flight", async () => {
    const server = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "fail",
    });
    // Mock executor to hang so we can test concurrency
    const hangPromise = new Promise(() => {});
    // biome-ignore lint/suspicious/noExplicitAny: accessing internal test hook on server instance
    (server as any)._testRunExecutor = () => hangPromise;

    server.callTool("greet", { name: "a" }); // no await
    const result = await server.callTool("greet", { name: "b" });
    expect(result.isError).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: accessing untyped structuredContent in test assertion
    expect((result.structuredContent as any).errorCode).toBe("BUSY");
  });

  it(
    "returns DURATION_EXCEEDED when workflow exceeds maxDurationSec",
    async () => {
      const hangWorkflow = defineWorkflow({
        name: "hang",
        mcp: { description: "Hangs forever", maxDurationSec: 0.1 },
        tasks: {
          hang: {
            agent: greetAgent,
          },
        },
      });

      const server = createMcpServer({
        workflow: hangWorkflow,
        cliCeilings: {},
        hitlStrategy: "fail",
        runWorkflow: async () => new Promise(() => {}), // never resolves
      });

      const result = await server.callTool("hang", { name: "x" });
      expect(result.isError).toBe(true);
      // biome-ignore lint/suspicious/noExplicitAny: accessing untyped structuredContent in test assertion
      expect((result.structuredContent as any).errorCode).toBe(
        "DURATION_EXCEEDED",
      );
    },
    { timeout: 2000 },
  );

  it("runs a workflow end-to-end with mocked runWorkflow injection", async () => {
    // Uses @ageflow/testing createTestHarness to inject a mock runner.
    // The real WorkflowExecutor takes the workflow with task inputs pre-set;
    // for a single-task root workflow, we inject input via a modified workflow.
    const { createTestHarness } = await import("@ageflow/testing");

    // Wrap harness as RunWorkflowFn: create a harness that knows the workflow,
    // inject input as the root task's static input, and run.
    const runWorkflow: RunWorkflowFn = async (args) => {
      // Build a workflow variant with the MCP input injected as the root task's input.
      const { defineWorkflow: dw } = await import("@ageflow/core");
      const wfWithInput = dw({
        ...args.workflow,
        tasks: {
          ...args.workflow.tasks,
          greet: {
            // biome-ignore lint/suspicious/noExplicitAny: spreading typed task config via untyped access for test injection
            ...(args.workflow.tasks as any).greet,
            input: args.input,
          },
        },
      });
      const harness = createTestHarness(wfWithInput);
      harness.mockAgent("greet", { greeting: "hello, Alice!" });
      const result = await harness.run();
      // Return the output task's output (boundary task is "greet" for this workflow)
      return result.outputs.greet;
    };

    const server = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "fail",
      runWorkflow,
    });

    const result = await server.callTool("greet", { name: "Alice" });
    expect(result.isError).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: accessing untyped structuredContent in test assertion
    expect((result.structuredContent as any).greeting).toBe("hello, Alice!");
  });
});
