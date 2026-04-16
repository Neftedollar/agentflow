# @ageflow/learning — Self-Evolving Skill Layer

> **Status**: Design approved
> **Issue**: #24
> **Inspired by**: [Memento-Skills](https://github.com/Memento-Teams/Memento-Skills) ([paper](https://arxiv.org/abs/2603.18743))
> **Date**: 2026-04-17

---

## 1. Summary

`@ageflow/learning` adds a self-evolving skill layer to AgentFlow workflows.
After each workflow run, an LLM reflection agent evaluates per-task performance
via DAG-aware credit assignment ("backpropagation"), generates improved skills
(markdown prompt injections), and versions them with automatic rollback to the
best-performing version. Learning workflows are themselves built with
`defineAgent` / `defineWorkflow` — the system learns through itself.

Existing workflows require **zero code changes**. Learning activates by passing
hooks from `createLearningHooks()` into any `defineWorkflow()`.

```ts
import { createLearningHooks } from "@ageflow/learning";
import { SqliteSkillStore } from "@ageflow/learning-sqlite";

const store = new SqliteSkillStore("~/.agentflow/skills.db");
const hooks = createLearningHooks({ store, strategy: "autonomous" });

const workflow = defineWorkflow({
  name: "bug-fix",
  tasks: { analyze, fix, test },
  hooks,
});
```

---

## 2. Package Architecture

### 2.1 Packages

| Package | Depends on | Purpose |
|---------|-----------|---------|
| `@ageflow/learning` | `@ageflow/core` (types only) | Interfaces (`SkillStore`, `TraceStore`), types (`SkillRecord`, `ExecutionTrace`), hooks (`createLearningHooks`), pre-built learning workflows (reflection, evaluation, promotion) |
| `@ageflow/learning-sqlite` | `@ageflow/learning`, `bun:sqlite` | `SqliteSkillStore` + `SqliteTraceStore` implementation with optional `sqlite-vec` for vector search |

### 2.2 Dependency rules

- `@ageflow/learning` depends on `@ageflow/core` for types only. It does NOT
  depend on `@ageflow/executor` — hooks are injected via `WorkflowHooks`, the
  executor is unaware of learning.
- `@ageflow/learning-sqlite` depends on `@ageflow/learning` for interfaces +
  `bun:sqlite` for storage.
- Learning workflows (reflection, evaluation) use `@ageflow/executor` at
  **runtime** (they ARE workflows), but the package boundary is clean — they
  import executor as a peer dependency.

### 2.3 Storage is pluggable

`SkillStore` and `TraceStore` are interfaces. Default implementation is SQLite.
Users can provide their own:

```ts
const hooks = createLearningHooks({
  store: new PostgresSkillStore(pool),  // custom implementation
});
```

### 2.4 sqlite-vec graceful degradation

`SqliteSkillStore` attempts to load `sqlite-vec` extension at init. If
unavailable (missing binary, unsupported platform):

- **Permanent warning** on every `search()` call: `"[ageflow/learning] sqlite-vec
  not available — falling back to keyword search. Install sqlite-vec for
  semantic skill retrieval."`
- Fallback: FTS5 full-text search on `name + description` fields.
- Vector search is not silently degraded — the warning ensures the user knows.

---

## 3. Data Model

### 3.1 SkillRecord

```ts
interface SkillRecord {
  id: string;                    // uuid
  name: string;                  // "analyze-root-cause-v3"
  description: string;           // retrieval text (embedding source)
  content: string;               // markdown — injected into agent prompt
  targetAgent: string;           // task name in workflow: "analyze"
  targetWorkflow?: string;       // optional: scope to specific workflow
  version: number;               // auto-increment on evolution
  parentId?: string;             // previous version (lineage tracking)
  status: "active" | "retired";
  score: number;                 // accumulated quality score (rolling window)
  runCount: number;              // how many times this version was used
  bestInLineage: boolean;        // is this the best-scoring version?
  createdAt: string;             // ISO timestamp
  embedding?: Float32Array;      // vector for similarity search
}
```

**Skill format**: skill content is **markdown text** — human-readable,
LLM-readable, git-diffable. It is injected into the agent's `systemPrompt` as
context/instructions. Skills are data, not code. No dynamic imports, no
execution — the LLM reads and follows the markdown.

### 3.2 ExecutionTrace

```ts
interface ExecutionTrace {
  id: string;
  workflowName: string;
  runAt: string;
  success: boolean;
  totalDurationMs: number;
  taskTraces: TaskTrace[];
  workflowInput: unknown;
  workflowOutput: unknown;
  feedback: Feedback[];          // accumulated delayed feedback
}

interface TaskTrace {
  taskName: string;              // "analyze", "fix", "test"
  agentRunner: string;           // "claude", "api", etc.
  prompt: string;                // full prompt (including injected skills)
  output: string;                // raw stdout
  parsedOutput: unknown;         // Zod-parsed result
  success: boolean;
  skillsApplied: string[];       // which skills were injected
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  retryCount: number;
}

interface Feedback {
  rating: "positive" | "negative" | "mixed";
  comment?: string;
  source: "human" | "ci" | "monitoring";
  timestamp: string;
}
```

### 3.3 Delayed feedback

Feedback accumulates on existing traces over time:

```ts
await store.addFeedback(traceId, {
  rating: "negative",
  comment: "PR was rejected — fix didn't address root cause",
  source: "human",
});
```

CLI shortcut: `agentwf feedback <traceId> --rating negative --comment "..."`

Reflection agent reads `trace.feedback[]` alongside `trace.success` and
`trace.taskTraces`. Delayed feedback outweighs immediate success/fail signals
when they conflict.

---

## 4. Store Interfaces

```ts
interface SkillStore {
  save(skill: SkillRecord): Promise<void>;
  get(id: string): Promise<SkillRecord | null>;
  getByTarget(targetAgent: string, targetWorkflow?: string): Promise<SkillRecord[]>;
  getActiveForTask(taskName: string, workflowName?: string): Promise<SkillRecord | null>;
  getBestInLineage(skillId: string): Promise<SkillRecord | null>;
  search(query: string, limit: number): Promise<ScoredSkill[]>;
  list(): Promise<SkillRecord[]>;
  retire(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

interface TraceStore {
  saveTrace(trace: ExecutionTrace): Promise<void>;
  getTrace(id: string): Promise<ExecutionTrace | null>;
  getTraces(filter: TraceFilter): Promise<ExecutionTrace[]>;
  addFeedback(traceId: string, feedback: Feedback): Promise<void>;
}

interface ScoredSkill {
  skill: SkillRecord;
  score: number;  // retrieval relevance, not quality score
}

interface TraceFilter {
  workflowName?: string;
  since?: string;        // ISO timestamp
  limit?: number;
  hasFeedback?: boolean;
}
```

---

## 5. Skill Injection

When a user workflow runs with learning hooks active:

1. `onTaskStart` hook reads from store: which skill is `status: "active"` for
   this `taskName` + `workflowName`.
2. Skill `content` (markdown) is prepended to `RunnerSpawnArgs.systemPrompt` —
   before the executor's Zod schema contract and sanitize directives.
3. `TaskTrace.skillsApplied` records which skills were injected (for credit
   assignment later).

Minimal executor change required (~5 lines): if hooks provide skill content,
concatenate with existing `systemPrompt`. Skill content goes first (context),
then schema contract (instructions).

---

## 6. Learning Loop — Three Workflows

All learning workflows are built with `defineAgent` / `defineWorkflow` — the
system learns through itself (meta-circularity, dogfooding).

### 6.1 reflectionWorkflow

Triggered automatically via `onWorkflowComplete` hook after each user workflow
run.

```
collectTrace → creditAssignment → generateSkillDrafts
```

**`collectTrace`** (deterministic, not LLM): assembles `ExecutionTrace` from
hooks + pulls accumulated feedback from store + retrieves last N traces for
this workflow (historical context).

**`creditAssignment`** (LLM agent, opus-tier):
- Input: current trace + feedback + historical traces + DAG structure
- Uses train/test split: sees 60% of historical traces for analysis, remaining
  40% held out for validation (prevents overfitting to specific cases)
- Output (Zod-validated):
  ```ts
  {
    workflowScore: number;           // 0-1 overall
    taskScores: Record<string, {
      score: number;                  // 0-1
      creditWeight: number;           // contribution to workflow result
      diagnosis: string;              // what went wrong / well
      improvementHint: string;        // direction for skill generation
    }>;
    workflowLevelInsight?: string;   // DAG-level observation
  }
  ```

**`generateSkillDrafts`** (LLM agent, sonnet-tier):
- Only runs for tasks with `score < threshold` (default 0.7)
- Input: task trace + diagnosis + existing skill (if any) + improvement hint +
  held-out traces for validation
- Output: new/updated `SkillRecord` with `status: "active"`
- If skill already exists → new version with `parentId` → lineage

### 6.2 evaluationWorkflow

Triggered by CLI: `agentwf learn evaluate` or programmatically.

```
selectCandidates → hypotheticalComparison → score
```

**No re-execution of real workflows.** No duplicate side effects.

**`hypotheticalComparison`** (LLM agent, opus-tier):
- Receives: historical task input, actual output, original prompt, skill
  content, downstream results
- Evaluates hypothetically: "would this skill have improved the output, given
  what happened downstream?"
- Single LLM call, zero side effects

Real validation happens naturally: the next actual workflow run uses the new
skill, and accumulated feedback + traces show whether it helped.

### 6.3 promotionWorkflow (versioning + rollback)

Deterministic (no LLM). Runs periodically or via CLI:
`agentwf learn promote`.

**Versioning model**:

```
v1 (active, score: 0.6)
  → v2 (active, score: 0.8)  ← current best
    → v3 (active, score: 0.4) ← reflection rewrote, but worse
      → rollback to v2
```

**Rules**:
1. New skill is immediately `active` — no staging.
2. After each workflow run, accumulated feedback updates the score of the
   current active skill version.
3. If score drops below threshold → reflection rewrites → new version.
4. If new version scores worse than previous after N runs → **automatic
   rollback to best version in lineage** (`bestVersion =
   lineage.maxBy(score)`).
5. Each version keeps its own score — scores are NOT reset on rollback.

**Promotion strategies** (configurable):
- `"autonomous"` — fully automatic: apply → score → rollback if worse
- `"hitl"` — reflection generates new version, but activation requires human
  approval via HITL checkpoint

---

## 7. Changes to Existing Packages

### 7.1 `@ageflow/core` — new types only

Add to `types.ts` (no logic changes):
- `ExecutionTrace` interface
- `TaskTrace` interface
- `Feedback` interface
- `SkillRecord` interface (or re-export from `@ageflow/learning`)

### 7.2 `@ageflow/executor` — ~5 lines

In `node-runner.ts`, when building `RunnerSpawnArgs`:
- If `hooks` provide skill content for this task (via a new optional
  `getSkillContent?: (taskName: string) => string | undefined` on
  `WorkflowHooks`), prepend to `systemPrompt`.

Guarded by optional chaining — zero impact when learning is not active.

### 7.3 `@ageflow/cli` — new subcommands

```bash
agentwf learn status              # show active skills, scores, lineage
agentwf learn evaluate            # run hypothetical evaluation
agentwf learn promote             # run promotion/rollback cycle
agentwf learn export              # dump skills as .skill.md files
agentwf learn import <path>       # import .skill.md into store
agentwf feedback <traceId> ...    # add delayed feedback
```

---

## 8. What's NOT in v1

- Remote skill marketplace / cloud sync
- Cross-workflow skill sharing (skills are scoped to workflow + task)
- Skill analytics dashboard / UI
- Automatic CI/monitoring integration for feedback (manual `addFeedback` only)
- PLAYBOOK execution mode (Memento's Python subprocess skills) — our skills
  are prompt-only
- BM25 retrieval (despite Memento paper claims, their code uses vector-only;
  we follow suit with sqlite-vec + FTS5 fallback)

---

## 9. Key Design Decisions

### 9.1 Learning as Workflow (Approach C)

Reflection, evaluation, and promotion are `defineWorkflow` / `defineAgent`
workflows, not custom imperative code. This dogfoods AgentFlow, proves the
framework is powerful enough for self-improvement, and lets users fork/customize
the learning pipeline.

### 9.2 LLM-based credit assignment

The credit assignment problem (which agent in the DAG caused the workflow
failure?) is solved by an LLM reflection agent, not heuristics. Quality of
credit assignment is critical — cheap heuristics produce cheap learning.
Learning can be disabled when the task stabilizes.

### 9.3 DAG-aware "backpropagation"

Workflow result (success/fail + quality) flows backward through the DAG. Each
agent receives a learning signal proportional to its contribution. Downstream
failures trace back to upstream causes.

### 9.4 No production A/B testing

Skills go directly to `active`. No staging, no duplicate runs. This avoids
side-effect duplication and complexity. Validation comes from accumulated
feedback over real runs + hypothetical offline evaluation.

### 9.5 Automatic rollback to best version

If a new skill version performs worse than the previous, automatic rollback to
the best-scoring version in the lineage. No manual intervention needed in
`"autonomous"` mode. Each version retains its own score — history is preserved.

### 9.6 Train/test split for generalization

Reflection agent sees only 60% of historical traces when generating skills.
Remaining 40% are held out for validation. This prevents overfitting to
specific cases — skills must generalize, not memorize.

### 9.7 Delayed feedback as first-class signal

Feedback can arrive hours/days after a workflow run. It accumulates on the
trace and is weighted higher than immediate success/fail signals. This captures
real-world quality that Zod validation cannot measure.

### 9.8 Pluggable storage

`SkillStore` and `TraceStore` are interfaces. Default: SQLite + sqlite-vec.
Users can implement PostgresSkillStore, TursoSkillStore, etc. Shipped as
separate packages (`@ageflow/learning-sqlite`).

### 9.9 sqlite-vec degradation with permanent warning

If sqlite-vec extension is unavailable, every `search()` call emits a warning.
Fallback is FTS5 keyword search. Not silent — the user knows they're missing
semantic retrieval.

### 9.10 Skill = data, not code

Skills are markdown text injected into agent prompts. No dynamic imports, no
code execution, no security concerns from user-generated skill content. The LLM
reads and follows the instructions.

---

## 10. Inspired by Memento-Skills — where we diverge

| Aspect | Memento-Skills | @ageflow/learning |
|--------|---------------|-------------------|
| Architecture | Single agent | Multi-agent DAG with credit assignment |
| Skill creation | Agent-initiated (pull) | Automatic via hooks (push) with configurable strategy |
| Versioning | `version` field exists but unused | Full lineage with auto-rollback |
| Rollback | Manual `cp -r` snapshots | Automatic rollback to best version |
| Evaluation | Offline blind A/B (human-initiated) | Hypothetical comparison (no duplicate runs) |
| Scoring | Per-session, not persisted | Accumulated per-version, persisted |
| Promotion | Implicit (better skills get selected) | Explicit (autonomous or HITL) |
| Delayed feedback | Not supported | First-class with accumulation |
| Storage | Python SQLAlchemy + sqlite-vec | Pluggable interface, default bun:sqlite + sqlite-vec |
| Learning loop | Human-in-the-loop always | Configurable: autonomous or HITL |
| Skill format | Markdown (SKILL.md) | Markdown (same — proven format) |
| Retrieval | Vector + full enumeration (no BM25 despite paper) | Vector (sqlite-vec) + FTS5 fallback |
