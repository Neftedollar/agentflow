/**
 * server.ts — Minimal SSE server using node:http + @ageflow/server.
 *
 * Endpoints:
 *   POST /runs          — start a workflow run, stream events as SSE
 *   POST /runs/:id/resume — resume a paused HITL checkpoint
 *
 * Run:
 *   bun server.ts
 *
 * Then trigger a run:
 *   curl -N -X POST http://localhost:3000/runs
 *
 * And resume a checkpoint:
 *   curl -X POST http://localhost:3000/runs/<runId>/resume \
 *     -H 'content-type: application/json' \
 *     -d '{"approved":true}'
 */

import { createServer } from "node:http";
import { createRunner } from "@ageflow/server";
import { triageWorkflow } from "./workflow.js";

const runner = createRunner();

const server = createServer(async (req, res) => {
  if (req.url === "/runs" && req.method === "POST") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    try {
      for await (const ev of runner.stream(triageWorkflow, {})) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
        // Do NOT break on checkpoint — keep draining until workflow:complete so
        // the run reaches a terminal state. The client can POST /runs/:id/resume
        // while the generator is suspended at the checkpoint.
      }
      res.end();
    } catch (err) {
      res.write(`event: error\ndata: ${String(err)}\n\n`);
      res.end();
    }
    return;
  }

  if (
    req.url?.startsWith("/runs/") &&
    req.url.endsWith("/resume") &&
    req.method === "POST"
  ) {
    const runId = req.url.split("/")[2] ?? "";
    let body = "";
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => {
      const approved = JSON.parse(body).approved === true;
      try {
        runner.resume(runId, approved);
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(404).end(String(err));
      }
    });
    return;
  }

  res.writeHead(404).end();
});

server.listen(3000, () => console.log("listening on :3000"));
