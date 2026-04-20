import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defineAgent,
  defineWorkflow,
  registerRunner,
  unregisterRunner,
} from "@ageflow/core";
import type {
  RunnerSpawnArgs,
  RunnerSpawnResult,
  WorkflowDef,
} from "@ageflow/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ErrorCode } from "../../errors.js";
import { createSqliteJobStore } from "../../index.js";
import type { McpToolResult } from "../../server.js";
import { ASYNC_OBSERVER_TOOL_NAMES, createMcpServer } from "../../server.js";

type SqliteRow = {
  readonly payload: string;
  readonly runId: string;
  readonly state: string;
  readonly lastEventAt: number;
};

const sqliteStores = new Map<string, Map<string, SqliteRow>>();

vi.mock("bun:sqlite", () => {
  class Database {
    constructor(private readonly dbPath: string) {}

    query(sql: string) {
      const normalized = sql.trim().replace(/\s+/g, " ");
      const getStore = () => {
        let store = sqliteStores.get(this.dbPath);
        if (!store) {
          store = new Map<string, SqliteRow>();
          sqliteStores.set(this.dbPath, store);
        }
        return store;
      };

      return {
        run: (params?: Record<string, unknown>) => {
          const store = getStore();
          if (normalized.startsWith("INSERT INTO jobs")) {
            const row: SqliteRow = {
              runId: String(params?.$runId),
              state: String(params?.$state),
              lastEventAt: Number(params?.$lastEventAt),
              payload: String(params?.$payload),
            };
            store.set(row.runId, row);
          } else if (
            normalized.startsWith("DELETE FROM jobs WHERE runId = $runId")
          ) {
            store.delete(String(params?.$runId));
          }
          return { changes: 1 };
        },
        get: (params?: Record<string, unknown>) => {
          const store = getStore();
          if (normalized.startsWith("SELECT payload FROM jobs WHERE runId")) {
            return store.get(String(params?.$runId));
          }
          return undefined;
        },
        all: () => {
          const store = getStore();
          if (normalized.startsWith("SELECT payload FROM jobs ORDER BY")) {
            return [...store.values()]
              .sort((a, b) => b.lastEventAt - a.lastEventAt)
              .map((row) => ({ payload: row.payload }));
          }
          if (
            normalized.startsWith("SELECT runId, state, lastEventAt FROM jobs")
          ) {
            return [...store.values()].map((row) => ({
              runId: row.runId,
              state: row.state,
              lastEventAt: row.lastEventAt,
            }));
          }
          return [];
        },
      };
    }

    close() {}
  }

  return { Database };
});

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

async function makeJobDbPath(prefix: string): Promise<{
  readonly dir: string;
  readonly dbPath: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `ageflow-${prefix}-`));
  return {
    dir,
    dbPath: path.join(dir, "jobs.sqlite"),
  };
}

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
    for (let i = 0; i < 50 && typeof release !== "function"; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(typeof release).toBe("function");
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

  it("applies maxConcurrentJobsPerWorkflow in single-workflow mode", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
      concurrency: {
        maxConcurrentJobs: 2,
        maxConcurrentJobsPerWorkflow: 1,
      },
    });

    let release!: () => void;
    h._testRunExecutor = () =>
      new Promise((res) => {
        release = () => res({ a: "ok" });
      });

    const first = h.callTool("start_ask", { q: "1" });
    for (let i = 0; i < 50 && typeof release !== "function"; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(typeof release).toBe("function");

    const second = await h.callTool("start_ask", { q: "2" });
    expect(second.isError).toBe(true);
    if (second.isError) {
      expect(second.structuredContent.errorCode).toBe("BUSY");
      expect(second.structuredContent.context).toMatchObject({
        scope: "workflow",
        kind: "start",
        workflowName: "ask",
        limit: 1,
        active: 1,
      });
    }

    release();
    await first;
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

describe("async mode: sqlite job store recovery", () => {
  it("recovers a completed job after recreating the server", async () => {
    const { dir, dbPath } = await makeJobDbPath("recovery");
    const jobStore1 = await createSqliteJobStore(dbPath);
    const server1 = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
      jobStore: jobStore1,
    });
    server1._testRunExecutor = async (args) => {
      const input = args as { q: string };
      return { a: `done:${input.q}` };
    };

    try {
      const startRes = await server1.callTool("start_ask", { q: "persist" });
      expect(startRes.isError).toBe(false);
      if (startRes.isError) throw new Error("start failed");

      const jobId = (startRes.structuredContent as { jobId: string }).jobId;
      let state = "running";
      for (let i = 0; i < 50 && state === "running"; i++) {
        await new Promise<void>((r) => setTimeout(r, 10));
        const statusRes = await server1.callTool("get_workflow_status", {
          jobId,
        });
        if (!statusRes.isError) {
          state = (statusRes.structuredContent as { state: string }).state;
        }
      }
      expect(state).toBe("done");

      const result1 = await server1.callTool("get_workflow_result", { jobId });
      expect(result1.isError).toBe(false);

      server1.dispose?.();
      jobStore1.close();

      const jobStore2 = await createSqliteJobStore(dbPath);
      const server2 = createMcpServer({
        workflow,
        cliCeilings: {},
        hitlStrategy: "auto",
        async: true,
        jobStore: jobStore2,
      });

      try {
        const statusRes = await server2.callTool("get_workflow_status", {
          jobId,
        });
        expect(statusRes.isError).toBe(false);
        if (!statusRes.isError) {
          expect(statusRes.structuredContent).toMatchObject({ state: "done" });
        }

        const resultRes = await server2.callTool("get_workflow_result", {
          jobId,
        });
        expect(resultRes.isError).toBe(false);
        if (!resultRes.isError) {
          expect(
            (resultRes.structuredContent as { output: { a: string } }).output.a,
          ).toBe("done:persist");
        }
      } finally {
        server2.dispose?.();
        jobStore2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps an in-flight job queryable after recreating the server", async () => {
    const { dir, dbPath } = await makeJobDbPath("inflight");
    const jobStore1 = await createSqliteJobStore(dbPath);
    const server1 = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
      jobStore: jobStore1,
    });
    let release!: (value: { a: string }) => void;
    server1._testRunExecutor = () =>
      new Promise<{ a: string }>((resolve) => {
        release = resolve;
      });

    try {
      const startRes = await server1.callTool("start_ask", { q: "hold" });
      expect(startRes.isError).toBe(false);
      if (startRes.isError) throw new Error("start failed");
      const jobId = (startRes.structuredContent as { jobId: string }).jobId;

      const jobStore2 = await createSqliteJobStore(dbPath);
      const server2 = createMcpServer({
        workflow,
        cliCeilings: {},
        hitlStrategy: "auto",
        async: true,
        jobStore: jobStore2,
      });

      try {
        const statusRes = await server2.callTool("get_workflow_status", {
          jobId,
        });
        expect(statusRes.isError).toBe(false);
        if (!statusRes.isError) {
          expect(statusRes.structuredContent).toMatchObject({
            state: "running",
          });
        }

        const resultRes = await server2.callTool("get_workflow_result", {
          jobId,
        });
        expect(resultRes.isError).toBe(false);
        if (!resultRes.isError) {
          expect(resultRes.structuredContent).toMatchObject({ pending: true });
        }

        release({ a: "finished" });
        await new Promise<void>((r) => setTimeout(r, 0));
      } finally {
        server2.dispose?.();
        jobStore2.close();
      }
    } finally {
      server1.dispose?.();
      jobStore1.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reaps expired persistent rows after reopening the same database", async () => {
    const { dir, dbPath } = await makeJobDbPath("ttl");
    const jobStore1 = await createSqliteJobStore(dbPath);
    const server1 = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
      jobTtlMs: 50,
      jobCheckpointTtlMs: 50,
      jobStore: jobStore1,
    });
    server1._testRunExecutor = async () => ({ a: "ttl" });

    try {
      const startRes = await server1.callTool("start_ask", { q: "expire" });
      expect(startRes.isError).toBe(false);
      if (startRes.isError) throw new Error("start failed");

      const jobId = (startRes.structuredContent as { jobId: string }).jobId;
      let state = "running";
      for (let i = 0; i < 50 && state === "running"; i++) {
        await new Promise<void>((r) => setTimeout(r, 10));
        const statusRes = await server1.callTool("get_workflow_status", {
          jobId,
        });
        if (!statusRes.isError) {
          state = (statusRes.structuredContent as { state: string }).state;
        }
      }
      expect(state).toBe("done");

      server1.dispose?.();
      jobStore1.close();

      const jobStore2 = await createSqliteJobStore(dbPath);
      const server2 = createMcpServer({
        workflow,
        cliCeilings: {},
        hitlStrategy: "auto",
        async: true,
        jobTtlMs: 50,
        jobCheckpointTtlMs: 50,
        jobStore: jobStore2,
      });

      try {
        await new Promise<void>((r) => setTimeout(r, 200));

        const statusRes = await server2.callTool("get_workflow_status", {
          jobId,
        });
        expect(statusRes.isError).toBe(true);
        if (statusRes.isError) {
          expect(statusRes.structuredContent.errorCode).toBe("JOB_NOT_FOUND");
        }

        const resultRes = await server2.callTool("get_workflow_result", {
          jobId,
        });
        expect(resultRes.isError).toBe(true);
        if (resultRes.isError) {
          expect(resultRes.structuredContent.errorCode).toBe("JOB_NOT_FOUND");
        }
      } finally {
        server2.dispose?.();
        jobStore2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

describe("async mode: input injection (#84 item 10)", () => {
  /**
   * Verifies that dispatchStart injects the runtime MCP call arguments into the
   * input task's `input` field before calling runner.fire().
   *
   * Without the fix, the executor reads the static task.input ({ q: "hi" })
   * as resolvedInput and builds the prompt from it — the runtime arg "Charlie"
   * is never seen. With the fix, the executor sees { q: "Charlie" } and the
   * prompt reflects that.
   *
   * We register a real fake runner (bypassing _testRunExecutor) so the executor
   * resolves task.input → calls runner.spawn with a prompt built from that input.
   * The spawn function captures the prompt and returns a response that encodes it,
   * letting us assert the correct input was injected.
   */
  it("start_ask with { q: 'Charlie' } runs with injected input, not static task input", async () => {
    const RUNNER_NAME = "fake-injection-test";
    let capturedPrompt = "";

    const fakeRunner = {
      validate: async () => ({ ok: true }),
      spawn: async (args: RunnerSpawnArgs): Promise<RunnerSpawnResult> => {
        capturedPrompt = args.prompt;
        // Return a valid output matching the agent's output schema.
        return {
          stdout: JSON.stringify({ a: `echo:${args.prompt}` }),
          sessionHandle: "",
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    };
    registerRunner(RUNNER_NAME, fakeRunner);

    const injectionAgent = defineAgent({
      runner: RUNNER_NAME,
      input: z.object({ q: z.string() }),
      output: z.object({ a: z.string() }),
      prompt: ({ q }) => `query:${q}`,
    });

    const injectionWorkflow = defineWorkflow({
      name: "ask",
      tasks: {
        // Static task.input is { q: "hi" } — the bug manifested when this was
        // used instead of the runtime arg { q: "Charlie" }.
        t: { agent: injectionAgent, input: { q: "hi" } },
      },
    });

    const h = createMcpServer({
      workflow: injectionWorkflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
    });

    try {
      // Call with runtime arg { q: "Charlie" } — should override static { q: "hi" }
      const startRes = await h.callTool("start_ask", { q: "Charlie" });
      expect(startRes.isError).toBe(false);
      if (startRes.isError) throw new Error("start_ask failed unexpectedly");

      const { jobId } = startRes.structuredContent as { jobId: string };

      // Poll until done (give the background fire() loop time to run).
      let state = "running";
      for (let i = 0; i < 50 && state === "running"; i++) {
        await new Promise<void>((r) => setTimeout(r, 10));
        const statusRes = await h.callTool("get_workflow_status", { jobId });
        if (!statusRes.isError) {
          state = (statusRes.structuredContent as { state: string }).state;
        }
      }
      expect(state).toBe("done");

      // The prompt must have been built from the runtime arg "Charlie", not from
      // the static task.input value "hi".
      expect(capturedPrompt).toBe("query:Charlie");
      expect(capturedPrompt).not.toBe("query:hi");

      // Result should reflect the prompt that was built.
      const resultRes = await h.callTool("get_workflow_result", { jobId });
      expect(resultRes.isError).toBe(false);
      if (!resultRes.isError) {
        const output = (
          resultRes.structuredContent as { output: { a: string } }
        ).output;
        expect(output.a).toContain("query:Charlie");
      }
    } finally {
      unregisterRunner(RUNNER_NAME);
      h.dispose?.();
    }
  });

  it("get_workflow_result returns correct output when called with runtime name (end-to-end poll)", async () => {
    /**
     * Uses _testRunExecutor path (consistent with other async tests) to verify
     * that start_ask({ q: "Charlie" }) → poll → get_workflow_result returns
     * { a: "hello, Charlie!" } — not the value derived from static task.input.
     *
     * This is the canonical regression test for #84 item 10: confirms that even
     * when the workflow defines a static task.input, the runtime arg wins.
     */
    const h = createMcpServer({
      workflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
    });

    // The executor receives the input passed via task.input injection.
    // We return a greeting that encodes the received input so we can assert
    // the right value arrived.
    h._testRunExecutor = async (args) => {
      const input = args as { q: string };
      return { a: `hello, ${input.q}!` };
    };

    try {
      const startRes = await h.callTool("start_ask", { q: "Charlie" });
      expect(startRes.isError).toBe(false);
      if (startRes.isError) throw new Error("start failed");

      const { jobId } = startRes.structuredContent as { jobId: string };

      // Poll until done.
      let state = "running";
      for (let i = 0; i < 50 && state === "running"; i++) {
        await new Promise<void>((r) => setTimeout(r, 10));
        const statusRes = await h.callTool("get_workflow_status", { jobId });
        if (!statusRes.isError) {
          state = (statusRes.structuredContent as { state: string }).state;
        }
      }
      expect(state).toBe("done");

      const resultRes = await h.callTool("get_workflow_result", { jobId });
      expect(resultRes.isError).toBe(false);
      if (!resultRes.isError) {
        const output = (
          resultRes.structuredContent as { output: { a: string } }
        ).output;
        // Must be "hello, Charlie!" — NOT "hello, hi!" (which would indicate the
        // static task.input { q: "hi" } was used instead of the runtime arg).
        expect(output.a).toBe("hello, Charlie!");
      }
    } finally {
      h.dispose?.();
    }
  });
});

describe("async mode: ceiling + HITL composition (#84 item 11)", () => {
  /**
   * Verifies that the async path applies composeCeilings before calling
   * runner.fire(). With cliCeilings: { maxCostUsd: 0.1 }, the composed workflow
   * must have budget.maxCost === 0.1.
   *
   * Uses _testOnComposedWorkflow to capture the workflow passed to runner.fire()
   * without needing to intercept the executor itself.
   */
  it("CLI ceiling override flows through to the composed workflow on the async path", async () => {
    const h = createMcpServer({
      workflow,
      cliCeilings: { maxCostUsd: 0.1 },
      hitlStrategy: "auto",
      async: true,
    });

    let captured: WorkflowDef | undefined;
    h._testOnComposedWorkflow = (wf) => {
      captured = wf;
    };
    h._testRunExecutor = async () => ({ a: "ok" });

    const startRes = await h.callTool("start_ask", { q: "hello" });
    expect(startRes.isError).toBe(false);

    // _testOnComposedWorkflow is called synchronously during start, before fire()
    // returns, so `captured` is available immediately after callTool resolves.
    expect(captured).toBeDefined();
    expect(captured?.budget).toBeDefined();
    // CLI override of 0.1 must be present in the composed workflow's budget.
    expect(captured?.budget?.maxCost).toBe(0.1);

    h.dispose?.();
  });

  /**
   * Verifies that the async path respects the HITL strategy ("fail") by wiring
   * an onCheckpoint resolver into runner.fire(). With hitlStrategy: "fail", any
   * checkpoint encountered during execution must be rejected, causing the run
   * to fail.
   *
   * Uses a real workflow with hitl: { mode: "checkpoint" } on the agent so the
   * executor actually fires a checkpoint event during task execution.
   */
  it("hitlStrategy 'fail' rejects checkpoints on the async path (job ends in failed state)", async () => {
    const RUNNER_NAME = "fake-hitl-test";

    // Agent with a mandatory checkpoint gate.
    const checkpointAgent = defineAgent({
      runner: RUNNER_NAME,
      input: z.object({ q: z.string() }),
      output: z.object({ a: z.string() }),
      prompt: ({ q }) => `q:${q}`,
      // biome-ignore lint/suspicious/noExplicitAny: HITLConfig type exists in core
      hitl: { mode: "checkpoint" } as any,
    });

    const checkpointWorkflow = defineWorkflow({
      name: "ask",
      tasks: { t: { agent: checkpointAgent, input: { q: "hi" } } },
    });

    // Register a fake runner — spawn should NOT be called since the checkpoint
    // fires before the task runs and "fail" strategy rejects it.
    let spawnCalled = false;
    registerRunner(RUNNER_NAME, {
      validate: async () => ({ ok: true }),
      spawn: async (_args: RunnerSpawnArgs): Promise<RunnerSpawnResult> => {
        spawnCalled = true;
        return {
          stdout: JSON.stringify({ a: "done" }),
          sessionHandle: "",
          tokensIn: 0,
          tokensOut: 0,
        };
      },
    });

    const h = createMcpServer({
      workflow: checkpointWorkflow,
      cliCeilings: {},
      hitlStrategy: "fail",
      async: true,
    });

    try {
      const startRes = await h.callTool("start_ask", { q: "gate" });
      expect(startRes.isError).toBe(false);
      if (startRes.isError) throw new Error("start failed");

      const jobId = (startRes.structuredContent as { jobId: string }).jobId;

      // Poll until the job leaves "running" state. With "fail" strategy, the
      // checkpoint is rejected immediately and the job transitions to "failed".
      let state = "running";
      for (let i = 0; i < 50 && state === "running"; i++) {
        await new Promise<void>((r) => setTimeout(r, 10));
        const statusRes = await h.callTool("get_workflow_status", { jobId });
        if (!statusRes.isError) {
          state = (statusRes.structuredContent as { state: string }).state;
        }
      }

      // The job must fail — checkpoint was rejected by the "fail" strategy.
      expect(state).toBe("failed");

      // Verify spawn was never called (checkpoint blocked execution before spawn).
      expect(spawnCalled).toBe(false);

      // get_workflow_result must return WORKFLOW_FAILED.
      const resultRes = await h.callTool("get_workflow_result", { jobId });
      expect(resultRes.isError).toBe(true);
      if (resultRes.isError) {
        expect(resultRes.structuredContent.errorCode).toBe("WORKFLOW_FAILED");
      }
    } finally {
      unregisterRunner(RUNNER_NAME);
      h.dispose?.();
    }
  });
});
