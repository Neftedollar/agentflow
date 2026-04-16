import { defineAgent, defineWorkflow } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCode } from "../../errors.js";
import type { McpToolResult } from "../../server.js";
import { ASYNC_OBSERVER_TOOL_NAMES, createMcpServer } from "../../server.js";

const agent = defineAgent({
  runner: "fake",
  input: z.object({ q: z.string() }),
  output: z.object({ a: z.string() }),
  prompt: () => "p",
});

const workflow = defineWorkflow({
  name: "ask",
  tasks: { t: { agent, input: { q: "hi" } } },
});

describe("async mode: listTools (#18)", () => {
  it("returns 1 tool when async is omitted (default)", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
    });
    const tools = await h.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ask"]);
  });

  it("returns 1 tool when async: false", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: false,
    });
    const tools = await h.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ask"]);
  });

  it("returns 6 tools when async: true (sync + 5 job tools)", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
    });
    const tools = await h.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "ask",
        "cancel_workflow",
        "get_workflow_result",
        "get_workflow_status",
        "resume_workflow",
        "start_ask",
      ].sort(),
    );
    h.dispose?.();
  });
});

describe("async mode: start_<wf> (#18)", () => {
  it("returns a jobId and registers a RunHandle in state 'running'", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
    });
    // Inject a no-op executor so we can observe the RunHandle without real work.
    h._testRunExecutor = async () => ({ a: "done" });

    const res = await h.callTool("start_ask", { q: "hello" });
    expect(res.isError).toBe(false);
    if (!res.isError) {
      expect(res.structuredContent).toMatchObject({
        jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
    }
    h.dispose?.();
  });

  it("rejects invalid input with INPUT_VALIDATION_FAILED", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
    });
    const res = await h.callTool("start_ask", { q: 42 });
    expect(res.isError).toBe(true);
    if (res.isError) {
      expect(res.structuredContent.errorCode).toBe("INPUT_VALIDATION_FAILED");
    }
    h.dispose?.();
  });
});

describe("async mode: inflight lock (#18)", () => {
  it("two concurrent start_* calls: second returns BUSY", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
    });
    let release!: () => void;
    h._testRunExecutor = () =>
      new Promise((res) => {
        release = () => res({ a: "ok" });
      });

    const first = h.callTool("start_ask", { q: "1" });
    const second = await h.callTool("start_ask", { q: "2" });
    expect(second.isError).toBe(true);
    if (second.isError) expect(second.structuredContent.errorCode).toBe("BUSY");

    release();
    await first;
    // Wait a macrotask cycle so onComplete fires and inflight resets.
    await new Promise<void>((r) => setTimeout(r, 0));

    const third = await h.callTool("start_ask", { q: "3" });
    expect(third.isError).toBe(false);
    h.dispose?.();
  });

  it("get_workflow_status is callable while a job is running", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
    });
    let release!: () => void;
    h._testRunExecutor = () =>
      new Promise((res) => {
        release = () => res({ a: "ok" });
      });

    const startRes = await h.callTool("start_ask", { q: "q" });
    if (startRes.isError) throw new Error("start failed");
    const jobId = (startRes.structuredContent as { jobId: string }).jobId;

    // While inflight — observer must not be blocked.
    const status = await h.callTool("get_workflow_status", { jobId });
    expect(status.isError).toBe(false);
    if (!status.isError) {
      expect(status.structuredContent.state).toBe("running");
    }

    release();
    h.dispose?.();
  });
});

describe("async mode: cancel_workflow (#18)", () => {
  it("start → cancel → status=cancelled → get_workflow_result yields JOB_CANCELLED", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
    });
    let release!: () => void;
    h._testRunExecutor = () =>
      new Promise((res) => {
        release = () => res({ a: "ok" });
      });

    const startRes = await h.callTool("start_ask", { q: "q" });
    if (startRes.isError) throw new Error("start failed");
    const jobId = (startRes.structuredContent as { jobId: string }).jobId;

    const cancelRes = await h.callTool("cancel_workflow", { jobId });
    expect(cancelRes.isError).toBe(false);
    if (!cancelRes.isError) {
      expect(cancelRes.structuredContent).toMatchObject({
        cancelled: true,
        priorState: "running",
      });
    }

    const status = await h.callTool("get_workflow_status", { jobId });
    if (!status.isError)
      expect(status.structuredContent.state).toBe("cancelled");

    const result = await h.callTool("get_workflow_result", { jobId });
    expect(result.isError).toBe(true);
    if (result.isError)
      expect(result.structuredContent.errorCode).toBe("JOB_CANCELLED");

    // Idempotent second cancel.
    const cancel2 = await h.callTool("cancel_workflow", { jobId });
    if (!cancel2.isError) {
      expect(cancel2.structuredContent).toMatchObject({
        cancelled: false,
        priorState: "cancelled",
      });
    }

    release();
    h.dispose?.();
  });
});

describe("async mode: JOB_NOT_FOUND (#18)", () => {
  it.each([
    "get_workflow_status",
    "get_workflow_result",
    "cancel_workflow",
    "resume_workflow",
  ])(
    "%s with unknown jobId → JOB_NOT_FOUND or INVALID_RUN_STATE",
    async (toolName) => {
      const h = createMcpServer({
        workflow,
        cliCeilings: {},
        hitlStrategy: "auto",
        async: true,
      });
      const res = await h.callTool(toolName, { jobId: "nope", approved: true });
      expect(res.isError).toBe(true);
      if (res.isError) {
        expect(["JOB_NOT_FOUND", "INVALID_RUN_STATE"]).toContain(
          res.structuredContent.errorCode,
        );
      }
      h.dispose?.();
    },
  );
});

describe("async mode: ASYNC_MODE_DISABLED (#18)", () => {
  it("calling a job tool when async=false returns ASYNC_MODE_DISABLED", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: false,
    });
    const res = await h.callTool("start_ask", { q: "hello" });
    expect(res.isError).toBe(true);
    if (res.isError) {
      expect(res.structuredContent.errorCode).toBe("ASYNC_MODE_DISABLED");
    }
  });
});

describe("async mode: reserved tool name guard (#84 item 12)", () => {
  it("throws RESERVED_TOOL_NAME when workflow is named get_workflow_status in async mode", () => {
    const reservedAgent = defineAgent({
      runner: "fake",
      input: z.object({ q: z.string() }),
      output: z.object({ a: z.string() }),
      prompt: () => "p",
    });
    const reservedWorkflow = defineWorkflow({
      name: "get_workflow_status",
      tasks: { t: { agent: reservedAgent, input: { q: "hi" } } },
    });
    expect(() =>
      createMcpServer({
        workflow: reservedWorkflow,
        cliCeilings: {},
        hitlStrategy: "auto",
        async: true,
      }),
    ).toThrow(
      /Workflow name "get_workflow_status" conflicts with a reserved async observer tool name/,
    );
  });

  it.each(ASYNC_OBSERVER_TOOL_NAMES)(
    "throws for each reserved observer name: %s",
    (reservedName) => {
      const ag = defineAgent({
        runner: "fake",
        input: z.object({ q: z.string() }),
        output: z.object({ a: z.string() }),
        prompt: () => "p",
      });
      const wf = defineWorkflow({
        name: reservedName,
        tasks: { t: { agent: ag, input: { q: "hi" } } },
      });
      expect(() =>
        createMcpServer({
          workflow: wf,
          cliCeilings: {},
          hitlStrategy: "auto",
          async: true,
        }),
      ).toThrow(/conflicts with a reserved async observer tool name/);
    },
  );

  it("does NOT throw when async is false, even with a reserved name", () => {
    const ag = defineAgent({
      runner: "fake",
      input: z.object({ q: z.string() }),
      output: z.object({ a: z.string() }),
      prompt: () => "p",
    });
    const wf = defineWorkflow({
      name: "get_workflow_status",
      tasks: { t: { agent: ag, input: { q: "hi" } } },
    });
    expect(() =>
      createMcpServer({
        workflow: wf,
        cliCeilings: {},
        hitlStrategy: "auto",
        async: false,
      }),
    ).not.toThrow();
  });

  it("does NOT throw for a normal workflow name in async mode", () => {
    expect(() =>
      createMcpServer({
        workflow,
        cliCeilings: {},
        hitlStrategy: "auto",
        async: true,
      }),
    ).not.toThrow();
  });
});
