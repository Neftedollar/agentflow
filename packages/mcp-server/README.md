# @ageflow/mcp-server

Expose ageflow workflows as MCP tools. Paired with the `agentwf mcp serve` CLI command.

## Status

v0.2.0 — stdio transport, workflow-as-tool, progress streaming, HITL via elicitation, **async job mode**.

## Usage via CLI

```bash
agentwf mcp serve ./workflow.ts
```

See the root `packages/cli/README.md` for CLI options.

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

## HTTP transport

By default `agentwf mcp serve` uses stdio (suitable for `claude_desktop_config.json`). For remote or team deployment, use the **Streamable HTTP transport** (MCP spec 2025-03-26).

### CLI

```bash
# Loopback only — no auth required
agentwf mcp serve ./workflow.ts --http --port 3000

# Non-loopback — bearer auth is mandatory
agentwf mcp serve ./workflow.ts --http --port 3000 \
  --host 0.0.0.0 --auth-bearer "$MCP_TOKEN"
```

Flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--http` | — | Enable HTTP transport instead of stdio |
| `--port <n>` | — | TCP port to bind (required with `--http`) |
| `--host <addr>` | `127.0.0.1` | Bind address |
| `--auth-bearer <token>` | — | Bearer token for auth (required for non-loopback hosts) |
| `--trust-proxy` | `false` | Trust `X-Forwarded-For` header (see below) |
| `--max-body-bytes <n>` | `1048576` | Maximum request body size in bytes (default: 1 MiB) |
| `--max-sessions <n>` | `1000` | Maximum concurrent MCP sessions |

### Programmatic API

```ts
import { createMcpServer } from "@ageflow/mcp-server";

const server = createMcpServer({
  workflows: [myWorkflow],
  transport: {
    type: "http",
    port: 3000,
    // host defaults to "127.0.0.1" (loopback-only)
    auth: { type: "bearer", token: process.env.MCP_TOKEN! },
    // Optional CORS for browser-based MCP clients:
    cors: { origin: "https://app.example.com" },
    // Optional in-memory rate limiter:
    rateLimit: { windowMs: 60_000, max: 100 },
    // Optional audit log:
    auditLog: (event) => {
      console.log(JSON.stringify(event));
    },
    // Set true ONLY when behind a trusted reverse proxy (nginx, Caddy, etc.).
    // See "trustProxy guidance" below. Default: false.
    trustProxy: false,
    // Maximum request body bytes — default 1 MiB. Excess → 413.
    maxBodyBytes: 1_048_576,
    // Maximum concurrent sessions — default 1000. Excess → 429.
    maxSessions: 1_000,
  },
});

await server.listen();
// server.httpHandle?.address() → { port: 3000, host: "127.0.0.1" }
```

### Security model

| Property | Default | Notes |
|----------|---------|-------|
| Bind address | `127.0.0.1` | Loopback-only. Use `0.0.0.0` for network-wide access. |
| Auth | `none` | Only valid on loopback. Non-loopback **requires** bearer auth. |
| CORS | disabled | Enable only if you have browser-based MCP clients. |
| TLS | none | **This transport speaks plain HTTP.** |
| `trustProxy` | `false` | See below. |
| `maxBodyBytes` | `1 MiB` | Requests larger than this are rejected with 413. |
| `maxSessions` | `1000` | Excess `initialize` requests are rejected with 429. |

#### `trustProxy` guidance

By default the server determines the client IP from the TCP socket's remote address. Set `trustProxy: true` **only** when the server runs behind a reverse proxy you control (nginx, Caddy, etc.) that sets `X-Forwarded-For` to the real client IP.

**Never set `trustProxy: true` on a server exposed directly to the internet.** Any client can forge the `X-Forwarded-For` header, which would let them bypass rate limiting and fake audit log entries.

```
# Safe: proxy you control sets X-Forwarded-For
Internet → nginx (sets X-Forwarded-For) → ageflow mcp (trustProxy: true)

# Unsafe: direct internet exposure
Internet → ageflow mcp (trustProxy: true)  ← attacker can set any X-Forwarded-For
```

### TLS guidance

The HTTP transport does not handle TLS. For production deployments on non-loopback interfaces, terminate TLS with a reverse proxy:

**Caddy** (automatic certificates):
```
mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

**nginx:**
```nginx
server {
  listen 443 ssl;
  server_name mcp.example.com;
  # ... TLS config ...
  location /mcp {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_buffering off;   # required for SSE streaming
  }
}
```

### Audit log example

```ts
const server = createMcpServer({
  workflows: [myWorkflow],
  transport: {
    type: "http",
    port: 3000,
    auth: { type: "bearer", token: process.env.MCP_TOKEN! },
    auditLog: (event) => {
      // event shape: { ts, remoteIp, toolName, method, authDenied, rateLimited }
      if (event.authDenied) {
        securityLogger.warn("MCP auth failure", { ip: event.remoteIp });
      }
      metricsClient.increment("mcp.request", {
        method: event.method ?? "unknown",
        tool: event.toolName ?? "none",
      });
    },
  },
});
```

## Before you expose

- Add HITL checkpoints for any destructive operations (`git push --force`, `rm -rf`, privileged Docker)
- Validate any raw input passed to shell/SQL
- Set `maxCostUsd` on workflows using expensive models
