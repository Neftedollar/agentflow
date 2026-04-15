# @ageflow/mcp-server

Expose ageflow workflows as MCP tools. Paired with the `agentwf mcp serve` CLI command.

## Status

v0.1 — stdio transport, workflow-as-tool, progress streaming, HITL via elicitation.

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

## Before you expose

- Add HITL checkpoints for any destructive operations (`git push --force`, `rm -rf`, privileged Docker)
- Validate any raw input passed to shell/SQL
- Set `maxCostUsd` on workflows using expensive models
