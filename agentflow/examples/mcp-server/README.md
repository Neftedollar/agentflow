# AgentFlow MCP Server Example

Minimal example of exposing an ageflow workflow as an MCP tool via the stdio transport.

## What it does

Defines a `greet` workflow with a single agent that greets a person by name. The workflow is exposed as an MCP tool:

- **Tool name**: `greet`
- **Input schema**: `{ name: string }`
- **Output schema**: `{ greeting: string }`

## Run the MCP server (stdio)

```bash
# Install dependencies (from monorepo root)
bun install

# Start the server (reads from stdin, writes to stdout — standard MCP stdio transport)
bun run serve

# Or with HITL set to auto-approve (no human-in-the-loop prompts)
bun run serve:auto
```

## Claude Desktop configuration

Add this snippet to your `claude_desktop_config.json` (usually at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "ageflow-greet": {
      "command": "bun",
      "args": [
        "run",
        "--cwd",
        "/absolute/path/to/agentflow/examples/mcp-server",
        "serve"
      ],
      "env": {}
    }
  }
}
```

Replace `/absolute/path/to/agentflow` with the actual path to this monorepo on your machine.

> **Note:** The `ANTHROPIC_API_KEY` environment variable must be set (or Claude CLI must be authenticated) for the runner to work.

## Integration test

```bash
bun run test
```

The test uses `InMemoryTransport` from the MCP SDK to connect a client to the server in-process (no real Claude calls — the runner is mocked).

## Async mode

For long-running workflows or clients that can't wait for a synchronous response,
enable **async job mode** with the `--async` flag:

```bash
bun run --cwd examples/mcp-server -- agentwf mcp serve workflow.ts \
  --async --hitl auto
```

In async mode, five additional tools are registered alongside the existing `greet` tool:

| Tool | Purpose |
|------|---------|
| `start_greet` | Fire the workflow; returns a `jobId` immediately |
| `get_workflow_status` | Poll run state (`running` / `done` / `failed` / `cancelled`) |
| `get_workflow_result` | Fetch validated output once state is `done` |
| `resume_workflow` | Approve or deny a pending HITL checkpoint |
| `cancel_workflow` | Abort an in-flight run |

### Polling snippet

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// After connecting the client...

// 1. Start the workflow.
const { content } = await client.callTool({
  name: "start_greet",
  arguments: { name: "Alice" },
});
const { jobId } = JSON.parse(content[0].text);

// 2. Poll until done.
let state = "running";
while (state === "running") {
  await new Promise((r) => setTimeout(r, 200));
  const res = await client.callTool({
    name: "get_workflow_status",
    arguments: { jobId },
  });
  ({ state } = JSON.parse(res.content[0].text));
}

// 3. Fetch the result.
const resultRes = await client.callTool({
  name: "get_workflow_result",
  arguments: { jobId },
});
const { output } = JSON.parse(resultRes.content[0].text);
console.log(output.greeting); // "Hello, Alice!"
```

The async scenario is covered by the integration test in `mcp-client.test.ts`
(the `"async mode via InMemoryTransport"` describe block). The runner is mocked
via `handle._testRunExecutor` — no real Claude CLI is invoked.

## Flags

```
agentwf mcp serve workflow.ts [flags]

  --max-cost <n>       max cost in USD (default: from workflow.mcp.maxCostUsd)
  --no-max-cost        disable cost ceiling
  --max-duration <n>   max duration in seconds
  --no-max-duration    disable duration ceiling
  --max-turns <n>      max agent turns
  --no-max-turns       disable turns ceiling
  --hitl <strategy>    elicit | auto | fail (default: elicit)
  --async              enable async job mode (adds 5 extra tools)
  --job-ttl <ms>       retention period for completed jobs (default: 1800000)
  --checkpoint-ttl <ms> retention period for paused checkpoints (default: 3600000)
  --name <name>        MCP server name (default: workflow name)
  --log-file <path>    also write stderr log to a file
```
