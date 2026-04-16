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

## Async job mode

By default the server exposes a single **synchronous streaming tool** that
blocks until the workflow finishes.  For long-running workflows (> 30 s) or
when you need fire-and-forget behaviour, enable **async job mode** with the
`--async` flag.

```bash
agentwf mcp serve ./workflow.ts --async
```

### When to use async mode

| Situation | Recommendation |
|-----------|---------------|
| Workflow takes > 30 s | Use async — avoid HTTP gateway timeouts |
| Client has no streaming/progress support | Use async — poll at your own pace |
| You need reconnect semantics (resume after disconnect) | Use async — `jobId` survives transport reconnections |
| Short interactive workflows | Sync mode is simpler |

### Tool surface

Async mode registers **five additional MCP tools** alongside the existing sync
tool (6 tools total):

| Tool | Input | Output | Description |
|------|-------|--------|-------------|
| `start_<workflow>` | Workflow input schema | `{ jobId: string }` | Fire the workflow; returns a `jobId` immediately |
| `get_workflow_status` | `{ jobId: string }` | `{ state, createdAt, lastEventAt, currentTask?, progress? }` | Poll run state (`running`, `awaiting-checkpoint`, `done`, `failed`, `cancelled`) |
| `get_workflow_result` | `{ jobId: string }` | `{ state: "done", output, metrics }` or `{ pending: true }` | Fetch the validated output (idempotent until TTL expires) |
| `resume_workflow` | `{ jobId: string, approved: boolean }` | `{ resumed: boolean }` | Approve or deny a pending HITL checkpoint |
| `cancel_workflow` | `{ jobId: string }` | `{ cancelled: boolean, priorState: string }` | Abort an in-flight run (idempotent) |

The existing synchronous tool is **not removed** — both surfaces are available.

### Error codes

| Code | Meaning |
|------|---------|
| `JOB_NOT_FOUND` | The supplied `jobId` is unknown (expired TTL or typo) |
| `JOB_CANCELLED` | `get_workflow_result` called on a cancelled job |
| `INVALID_RUN_STATE` | Operation not valid in the job's current state (e.g. `resume_workflow` on a non-paused job) |
| `ASYNC_MODE_DISABLED` | A job tool was called but the server was started without `--async` |
| `BUSY` | A second `start_*` was fired while the inflight lock is held |

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

### Known limitations

- **No persistence** — the job registry is in-memory only. Restarting the
  server loses all job state.
- **Single-instance** — the registry is not shared across processes. Running
  multiple server processes will have independent job stores.
- **Single BUSY lock** — only one `start_*` call can be in-flight at a time.
  A second concurrent start returns `BUSY` immediately.

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
      "text": "{\"jobId\":\"550e8400-e29b-41d4-a716-446655440000\"}" }] } }
```

**2. Poll status**

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "get_workflow_status",
              "arguments": { "jobId": "550e8400-e29b-41d4-a716-446655440000" } } }
```

Response (still running):
```json
{ "jsonrpc": "2.0", "id": 2, "result":
  { "content": [{ "type": "text",
      "text": "{\"state\":\"running\",\"createdAt\":1713312000000,\"lastEventAt\":1713312001000}" }] } }
```

**3. Fetch result once done**

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "get_workflow_result",
              "arguments": { "jobId": "550e8400-e29b-41d4-a716-446655440000" } } }
```

**4. Resume a HITL checkpoint**

```json
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
  "params": { "name": "resume_workflow",
              "arguments": { "jobId": "550e8400-e29b-41d4-a716-446655440000", "approved": true } } }
```

**5. Cancel a running job**

```json
{ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
  "params": { "name": "cancel_workflow",
              "arguments": { "jobId": "550e8400-e29b-41d4-a716-446655440000" } } }
```

## Before you expose

- Add HITL checkpoints for any destructive operations (`git push --force`, `rm -rf`, privileged Docker)
- Validate any raw input passed to shell/SQL
- Set `maxCostUsd` on workflows using expensive models
