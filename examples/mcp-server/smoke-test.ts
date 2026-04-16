import { spawn } from "node:child_process";
import path from "node:path";

const dirname = import.meta.dirname ?? ".";

const workflowPath = path.resolve(dirname, "workflow.ts");
const cliPath = path.resolve(dirname, "../../packages/cli/dist/bin.js");

const server = spawn(
  "bun",
  [cliPath, "mcp", "serve", workflowPath, "--hitl", "auto"],
  {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: dirname,
  },
);

server.stderr.on("data", (d: Buffer) => {
  process.stderr.write(`[server stderr] ${d.toString()}`);
});

let buffer = "";
server.stdout.on("data", (d: Buffer) => {
  buffer += d.toString();
  let newlineIdx = buffer.indexOf("\n");
  while (newlineIdx !== -1) {
    const line = buffer.slice(0, newlineIdx);
    buffer = buffer.slice(newlineIdx + 1);
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        console.log("\n← RESPONSE:", JSON.stringify(msg, null, 2));
        handleResponse(msg);
      } catch {
        console.log("[raw]", line);
      }
    }
    newlineIdx = buffer.indexOf("\n");
  }
});

let step = 0;

function send(msg: Record<string, unknown>) {
  const json = JSON.stringify(msg);
  console.log(`\n→ SEND: ${json}`);
  server.stdin.write(`${json}\n`);
}

function handleResponse(msg: Record<string, unknown>) {
  step++;
  if (step === 1) {
    // Got initialize response → send tools/list
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
  } else if (step === 2) {
    // Got tools/list response → done
    console.log("\n✅ Smoke test complete. Killing server.");
    server.kill("SIGTERM");
    setTimeout(() => process.exit(0), 500);
  }
}

// Start: send initialize
setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {
        elicitation: {},
      },
      clientInfo: {
        name: "smoke-test",
        version: "0.0.1",
      },
    },
  });
}, 300);

setTimeout(() => {
  console.log("\n⏰ Timeout — server didn't respond in 10s");
  server.kill("SIGTERM");
  process.exit(1);
}, 10000);
