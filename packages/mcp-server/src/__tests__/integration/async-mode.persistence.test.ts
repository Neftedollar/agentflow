import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineAgent, defineWorkflow } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSingleWorkflowServer } from "../../server.js";

const completedAgent = defineAgent({
  runner: "completed-stub",
  input: z.object({ q: z.string() }),
  output: z.object({ a: z.string() }),
  prompt: () => "p",
});

const completedWorkflow = defineWorkflow({
  name: "completed_workflow",
  tasks: { t: { agent: completedAgent, input: { q: "seed" } } },
});

const checkpointAgent = defineAgent({
  runner: "checkpoint-stub",
  input: z.object({ q: z.string() }),
  output: z.object({ a: z.string() }),
  prompt: () => "p",
  hitl: { mode: "checkpoint", message: "approve?" },
});

const checkpointWorkflow = defineWorkflow({
  name: "checkpoint_workflow",
  tasks: { t: { agent: checkpointAgent, input: { q: "seed" } } },
});

function makeDbPath(prefix: string): { readonly dir: string; readonly dbPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ageflow-${prefix}-`));
  return { dir, dbPath: path.join(dir, "jobs.sqlite") };
}

async function waitForState(
  server: ReturnType<typeof createSingleWorkflowServer>,
  state: string,
  jobId: string,
): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const res = await server.callTool("get_workflow_status", { jobId });
    if (!res.isError) {
      const current = res.structuredContent as { state?: string };
      if (current.state === state) return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for state=${state}`);
}

describe("async mode persistence", () => {
  it("recovers a completed job after restart", async () => {
    const { dir, dbPath } = makeDbPath("completed");
    const server1 = createSingleWorkflowServer({
      workflow: completedWorkflow,
      cliCeilings: {},
      hitlStrategy: "auto",
      async: true,
      jobDbPath: dbPath,
    });
    server1._testRunExecutor = async (args) => {
      const input = args as { q: string };
      return { a: `done:${input.q}` };
    };

    try {
      const start = await server1.callTool("start_completed_workflow", {
        q: "persist",
      });
      expect(start.isError).toBe(false);
      if (start.isError) throw new Error("start failed");
      const jobId = (start.structuredContent as { jobId: string }).jobId;

      await waitForState(server1, "done", jobId);
      server1.dispose?.();

      const server2 = createSingleWorkflowServer({
        workflow: completedWorkflow,
        cliCeilings: {},
        hitlStrategy: "auto",
        async: true,
        jobDbPath: dbPath,
      });
      try {
        const status = await server2.callTool("get_workflow_status", { jobId });
        expect(status.isError).toBe(false);
        if (!status.isError) {
          expect(status.structuredContent).toMatchObject({ state: "done" });
        }

        const result = await server2.callTool("get_workflow_result", { jobId });
        expect(result.isError).toBe(false);
        if (!result.isError) {
          expect(result.structuredContent).toMatchObject({
            state: "done",
            output: { a: "done:persist" },
          });
        }
      } finally {
        server2.dispose?.();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers an awaiting-checkpoint job after restart", async () => {
    const { dir, dbPath } = makeDbPath("checkpoint");
    const server1 = createSingleWorkflowServer({
      workflow: checkpointWorkflow,
      cliCeilings: {},
      hitlStrategy: "elicit",
      async: true,
      jobDbPath: dbPath,
    });
    server1._testRunExecutor = async (args) => {
      const input = args as { q: string };
      return { a: `done:${input.q}` };
    };

    try {
      const start = await server1.callTool("start_checkpoint_workflow", {
        q: "pause",
      });
      expect(start.isError).toBe(false);
      if (start.isError) throw new Error("start failed");
      const jobId = (start.structuredContent as { jobId: string }).jobId;

      await waitForState(server1, "awaiting-checkpoint", jobId);
      server1.dispose?.();

      const server2 = createSingleWorkflowServer({
        workflow: checkpointWorkflow,
        cliCeilings: {},
        hitlStrategy: "elicit",
        async: true,
        jobDbPath: dbPath,
      });
      try {
        const status = await server2.callTool("get_workflow_status", { jobId });
        expect(status.isError).toBe(false);
        if (!status.isError) {
          expect(status.structuredContent).toMatchObject({
            state: "awaiting-checkpoint",
          });
        }

        const result = await server2.callTool("get_workflow_result", { jobId });
        expect(result.isError).toBe(false);
        if (!result.isError) {
          expect(result.structuredContent).toMatchObject({ pending: true });
        }

        let resume = await server2.callTool("resume_workflow", {
          jobId,
          approved: true,
        });
        for (let i = 0; i < 20 && resume.isError; i += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          resume = await server2.callTool("resume_workflow", {
            jobId,
            approved: true,
          });
        }
        expect(resume.isError).toBe(false);

        await waitForState(server2, "done", jobId);
        const done = await server2.callTool("get_workflow_result", { jobId });
        expect(done.isError).toBe(false);
        if (!done.isError) {
          expect(done.structuredContent).toMatchObject({
            state: "done",
            output: { a: "done:pause" },
          });
        }
      } finally {
        server2.dispose?.();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
