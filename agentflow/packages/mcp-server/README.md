# @ageflow/mcp-server

Expose ageflow workflows as MCP tools. Paired with the `agentwf mcp serve` CLI command.

## Status

v0.2.0 — stdio transport, workflow-as-tool, progress streaming, HITL via elicitation, **async job mode**.

## Usage via CLI

```bash
agentwf mcp serve ./workflow.ts
```

See the root `agentflow/packages/cli/README.md` for CLI options.

## Claude Desktop config

```json
{
  "mcpServers": {
    "my-workflow": {
      "command": "agentwf",
      "args": ["mcp", "serve", "/absolute/path/to/workflow.ts"]
    }
  }
}
```

## Async mode

By default the server exposes a single **synchronous streaming tool** that
blocks until the workflow finishes.  For long-running workflows (> 30 s) or
when you need fire-and-forget behaviour, enable **async mode** with the
`--async` flag.

```bash
agentwf mcp serve ./workflow.ts --async
```

### What changes in async mode

Async mode adds **five additional MCP tools** alongside the existing sync tool:

| Tool | Description |
|------|-------------|
| `start_<workflow>` | Fire the workflow; returns a `runId` immediately |
| `get_workflow_status` | Poll run state (`running`, `awaiting-checkpoint`, `done`, `failed`, `cancelled`) |
| `get_workflow_result` | Fetch the final output (idempotent until TTL expires) |
| `resume_workflow` | Approve or deny a pending HITL checkpoint |
| `cancel_workflow` | Abort an in-flight run |

The existing synchronous tool is **not removed** — both surfaces are available.

### TTL configuration

```bash
# Keep completed jobs for 1 hour (default: 30 min)
agentwf mcp serve ./workflow.ts --async --job-ttl 3600000

# Keep pending HITL checkpoints for 2 hours (default: 1 hour)
agentwf mcp serve ./workflow.ts --async --checkpoint-ttl 7200000
```

| Flag | Default | Description |
|------|---------|-------------|
| `--job-ttl <ms>` | `1800000` (30 min) | How long completed/failed/cancelled job results are retained |
| `--checkpoint-ttl <ms>` | `3600000` (1 hour) | How long a paused HITL checkpoint waits before auto-rejecting |

### Example JSON-RPC exchange

**1. Start the workflow**

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "start_greet", "arguments": { "name": "Alice" } } }
```

Response:
```json
{ "jsonrpc": "2.0", "id": 1, "result":
  { "content": [{ "type": "text",
      "text": "{\"runId\":\"run_01HZ\",\"state\":\"running\"}" }] } }
```

**2. Poll status**

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "get_workflow_status",
              "arguments": { "runId": "run_01HZ" } } }
```

Response (still running):
```json
{ "jsonrpc": "2.0", "id": 2, "result":
  { "content": [{ "type": "text",
      "text": "{\"runId\":\"run_01HZ\",\"state\":\"running\",\"completedTasks\":2,\"totalTasks\":5}" }] } }
```

**3. Fetch result once done**

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "get_workflow_result",
              "arguments": { "runId": "run_01HZ" } } }
```

**4. Resume a HITL checkpoint**

```json
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
  "params": { "name": "resume_workflow",
              "arguments": { "runId": "run_01HZ", "approved": true } } }
```

**5. Cancel a running job**

```json
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
  "params": { "name": "cancel_workflow",
              "arguments": { "runId": "run_01HZ" } } }
```

## Before you expose

- Add HITL checkpoints for any destructive operations (`git push --force`, `rm -rf`, privileged Docker)
- Validate any raw input passed to shell/SQL
- Set `maxCostUsd` on workflows using expensive models
