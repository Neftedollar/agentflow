# server-embed example

Minimal demo: embed `@ageflow/server` in a raw `node:http` server, stream
workflow events as Server-Sent Events (SSE), and handle a HITL checkpoint
from a second HTTP request.

## Quick start

```bash
# Install dependencies (from the monorepo root)
bun install

# Start the server
bun server.ts
# Listening on :3000
```

Requires `OPENAI_API_KEY` (or set `OPENAI_BASE_URL` to a compatible endpoint).

## Trigger a run

```bash
# Stream events as SSE — the server pauses at the checkpoint
curl -N -X POST http://localhost:3000/runs
# data: {"type":"workflow:start","runId":"<id>", ...}
# data: {"type":"task:start","taskName":"classify", ...}
# data: {"type":"checkpoint","runId":"<id>","message":"Approve classification?", ...}
```

## Resume a checkpoint

```bash
# Approve (continues the workflow)
curl -X POST http://localhost:3000/runs/<runId>/resume \
  -H 'content-type: application/json' \
  -d '{"approved":true}'

# Reject (workflow fails with HitlRejectedError)
curl -X POST http://localhost:3000/runs/<runId>/resume \
  -H 'content-type: application/json' \
  -d '{"approved":false}'
```

## Run tests

Tests use a stub runner — no API key needed.

```bash
bun run test
```
