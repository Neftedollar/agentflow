# bug-fix-pipeline

Example AgentFlow workflow demonstrating:
- **Loop with session persistence** — `fix → eval` retries up to 3× in shared conversation context
- **HITL checkpoint** — `fixAgent` pauses for human approval before applying a patch
- **Typed ctx access** — `CtxFor<WorkflowTasks, "summarize">` for type-safe output access
- **Test harness** — full pipeline test with `createTestHarness` and mock agents

## Pipeline

```
analyze ──→ fixLoop (fix → eval, up to 3×) ──→ summarize
```

1. **analyze** — scans a repo path for issues, returns a list
2. **fix** — generates a patch for the first issue (with HITL checkpoint); on retry, receives the previous patch as context
3. **eval** — scores the patch; if `satisfied === false`, loop retries
4. **summarize** — writes a final report using the original issue list and fix result

## Running with mock CLIs

The `__mocks__/` directory contains shell scripts that simulate `claude` and `codex` CLIs without network calls. Prepend the directory to `PATH` to use them:

```sh
PATH="$PWD/__mocks__:$PATH" agentwf run workflow.ts
```

Or use the `smoke` script:

```sh
bun run smoke
```

## Running tests

```sh
bun run test
```

The test suite uses `createTestHarness` to mock all agents in-process — no subprocess or network calls needed.

## Key patterns

### Loop context

`loop.input` returns an object whose keys are merged into the inner task context. The `fix` and `eval` tasks access `ctx["issue"].output` to get the issue passed from the outer `analyze` result.

On retry (iteration ≥ 2), `ctx["__loop_feedback__"].output` holds the previous iteration's full output map, allowing `fix` to surface what didn't work.

### Session persistence

`fix` and `eval` share `fixSession = sessionToken("fix-context", "claude")`. With `context: "persistent"`, the runner reuses the same conversation handle across loop iterations so the model retains memory of its prior attempts.

### HITL bypass in tests

`fixAgent` has `hitl: { mode: "checkpoint" }`. In tests, this is bypassed by wrapping the workflow with an auto-approving `onCheckpoint` hook:

```typescript
const workflowForTest: WorkflowDef = {
  ...(workflow as WorkflowDef),
  hooks: {
    onCheckpoint: (_taskName, _message) => Promise.resolve(true),
  },
};
```

### Type-safe ctx

`CtxFor<WorkflowTasks, "summarize">` extracts the output types of all `dependsOn` keys. Because `input` function parameters are structurally typed (not generic), use `as unknown as Ctx` to safely narrow:

```typescript
input: (ctx: unknown) => {
  type Ctx = CtxFor<WorkflowTasks, "summarize">;
  const typed = ctx as unknown as Ctx;
  return { originalIssues: typed.analyze.output.issues, ... };
},
```
