# dogfooding

**Ageflow dev pipeline as an ageflow workflow.**

We use ageflow to build ageflow. This workflow is the `feature` pipeline from
[`docs/process.md`](../docs/process.md) expressed as DSL.

## Pipeline

```
PLAN ──► BUILD LOOP ──► VERIFY ──► SHIP
          ▲    │
          │    ▼
         TEST (3× max)
```

| Step | Agent model | Process.md role |
|------|-------------|-----------------|
| `plan` | claude-opus-4-6 | PM + Architect |
| `build` | claude-sonnet-4-6 | Engineering |
| `test` | claude-haiku-4-5 | CI runner |
| `verify` | claude-opus-4-6 | Code Reviewer + Reality Checker |
| `ship` | claude-haiku-4-5 | DevOps / git |

## Key DSL patterns demonstrated

### Loop with feedback
`buildLoop` runs `build → test` up to 3 times. Each retry, `testAgent`'s failure
is surfaced back to `buildAgent` via `__loop_feedback__`. The build session is
persistent so the model retains context across retries.

```
iteration 1: build(plan) → test → failed
iteration 2: build(plan + failure₁) → test → failed
iteration 3: build(plan + failure₂) → test → passed ✓
```

### HITL checkpoint
`shipAgent` has `hitl` configured. If `plan.requiresCeoApproval === true`
(breaking API change, public content, costly infra), the workflow pauses before
SHIP for human approval.

### Type-safe context with CtxFor
`verify` and `ship` use `CtxFor<WorkflowTasks, "taskName">` to get fully typed
access to upstream outputs — no `as any`, no runtime surprises.

### Model tier matching process.md
| Tier | Model | Steps |
|------|-------|-------|
| Strategic | opus | plan, verify |
| Execution | sonnet | build |
| Routine | haiku | test, ship |

## Run

```bash
# Preview the execution plan and rendered prompts
agentwf dry-run workflow.ts

# Validate DAG and runner availability
agentwf validate workflow.ts

# Run with real Claude CLI
agentwf run workflow.ts
```

## Expose to Claude Desktop via MCP

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ageflow-dev-pipeline": {
      "command": "agentwf",
      "args": ["mcp", "serve", "/absolute/path/to/dogfooding/workflow.ts"]
    }
  }
}
```

Restart Claude Desktop. The tool `dev-pipeline` becomes available with progress streaming and HITL elicitation at the verify checkpoint.

## Difference from real orchestrator

The real orchestrator in `/orchestrator` is a meta-agent that dynamically selects
roles and spawns subagents via the Claude Code `Agent` tool. This workflow is a
*static* DAG — tasks and their connections are fixed at definition time.

The ageflow DSL shines for **predictable, repeatable pipelines** (feature→build→test→ship).
The orchestrator pattern is better for **open-ended, adaptive** work where the next step
depends on what the previous step discovered.
