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
  --name <name>        MCP server name (default: workflow name)
  --log-file <path>    also write stderr log to a file
```
