# Unified SessionStore — Design Spike

**Date:** 2026-04-18
**Issue:** [#98](https://github.com/ageflow/agents-workflow/issues/98)
**Status:** Spike — awaiting CEO decision
**Author:** Software Architect
**Related:** #91 (native Anthropic HTTP runner — landed), #120 (sAIler dogfood feedback)

---

## 1. Problem Statement

`SessionStore` today is a private concept of `@ageflow/runner-api`. It lives at
`packages/runners/api/src/session-store.ts:3-7` and is passed to `ApiRunner` via
the constructor config (`packages/runners/api/src/types.ts:44`). When `#91`
landed we copy-pasted the same pattern into `@ageflow/runner-anthropic`
(`packages/runners/anthropic/src/session-store.ts:10-14`) but typed it over
`AnthropicMessage[]` instead of `ChatMessage[]`. Meanwhile `runner-claude` and
`runner-codex` do not have a store at all — they rely on the CLI to persist the
session on disk and only shuttle an opaque `sessionHandle: string` through the
executor (`packages/runners/claude/src/claude-runner.ts:161-163`,
`packages/runners/codex/src/codex-runner.ts:193-205`).

**Concrete breakage for sAIler (the first real consumer):**

1. sAIler wants one Postgres-backed `SessionStore` to persist the whole
   dialogue, regardless of which runner serves a given turn. Today the
   consumer must implement the `SessionStore` interface twice (once for api
   with `ChatMessage[]`, once for anthropic with `AnthropicMessage[]`) and
   keep two rows in sync manually.
2. A workflow that plans in `runner-claude` then executes in `runner-api` with
   a shared `SessionToken` silently loses the CLI session — `runner-api`'s
   store has never seen that token, so it starts a fresh conversation. The
   executor carries the handle correctly
   (`packages/executor/src/workflow-executor.ts:593-626`); the runner simply
   cannot interpret it.
3. Observability / audit (issue #120, sAIler item 2) wants to inspect session
   contents uniformly. Today each runner owns its own store shape, so an
   audit probe has to know the runner brand to decode the messages.
4. The naming `get`/`set`/`delete` and `ChatMessage` do not match the common
   `load`/`save`/`Message` vocabulary sAIler expects (#120, sAIler item 2).
   This is cosmetic but reinforces that the store "belongs to runner-api".

**Future consumer needs** (server #26, mcp-server #18, multi-replica deploys):

- Durable conversation state across process restarts.
- Multi-replica safe — no "last write wins" based on in-memory caches.
- Cross-runner continuity (a single `SessionToken` remains the canonical
  anchor even if the agent behind it changes runner brand).
- Inspectable from outside the runner process (read-only views, replay).

---

## 2. Current State

### 2.1 Per-runner storage matrix

| Runner | Handle source | Persistence | Format | Instance config |
|---|---|---|---|---|
| `runner-api` | `crypto.randomUUID()` fallback or caller-supplied (`api-runner.ts:134-137`) | `SessionStore` (DI, `InMemorySessionStore` default) | `ChatMessage[]` (`openai-types.ts:1-5`) | `ApiRunnerConfig.sessionStore` (`types.ts:44`) |
| `runner-anthropic` | `crypto.randomUUID()` fallback or caller-supplied (`anthropic-runner.ts:189-192`) | `AnthropicSessionStore` (DI, `InMemoryAnthropicSessionStore` default) | `AnthropicMessage[]` (`anthropic-types.ts:52-55`) | `AnthropicRunnerConfig.sessionStore` (`anthropic-runner.ts:119`) |
| `runner-claude` | `session_id` parsed from `--output-format=json` result line (`claude-runner.ts:274`) | External — the `claude` CLI owns session state on disk; resumed via `--resume` flag (`claude-runner.ts:161-163`) | N/A (opaque to us) | None |
| `runner-codex` | `thread_id` parsed from `thread.started` event (`codex-runner.ts:248-252`, `296`) | External — the `codex` CLI owns session state on disk; resumed via positional `resume <THREAD_ID>` (`codex-runner.ts:193-205`) | N/A (opaque to us) | None |

### 2.2 What the executor sees today

The executor is already runner-agnostic about session handles. It holds a
`SessionManager` (`packages/executor/src/session-manager.ts:11`) that:

- Resolves `SessionToken` and `ShareSessionRef` to a canonical token name
  (`session-manager.ts:75-129`).
- Maps canonical token → last-seen `sessionHandle` string
  (`session-manager.ts:32-49`).
- Hands the string to the runner via `RunnerSpawnArgs.sessionHandle`
  (`packages/executor/src/node-runner.ts:328-336`).
- Stores the string returned in `RunnerSpawnResult.sessionHandle`
  (`workflow-executor.ts:620-627`).

The executor treats the handle as an **opaque `string`**. This is the crucial
asymmetry: the executor already does the runner-agnostic half of the work;
the runner-local `SessionStore` duplicates it for HTTP-backed runners only.

### 2.3 Session types in core

`packages/core/src/types.ts:282-302` defines the phantom-branded session
types: `SessionToken<R>` (named group), `ShareSessionRef<R>` (inherit from
another task), and the `SessionRef<R>` union. The runner brand `R` is
enforced at **compile time** (`TaskDef.session?: SessionRef<RunnerOf<A>>`,
`types.ts:602`) — so the type system currently prohibits cross-runner session
sharing outright. Any unified store design has to decide whether to preserve
that compile-time wall or relax it behind an opt-in escape hatch.

### 2.4 Handle overrides

`RunnerOverrides[brand].sessionHandle` lets callers inject a handle per
`execute()`/`stream()` call (`types.ts:221-226`); `node-runner.ts:328-330`
resolves the effective handle. Any redesign must preserve this escape hatch.

---

## 3. Design Goals

| # | Goal | Non-negotiable? |
|---|---|---|
| G1 | One `SessionStore` implementation can back every runner | Yes — core motivation |
| G2 | Pluggable storage (memory, SQLite, Postgres, Redis) | Yes |
| G3 | Existing `runner-api` and `runner-anthropic` consumers keep working with a deprecation window, not a hard break | Yes |
| G4 | TypeScript catches accidental cross-provider session assignment at compile time (brand wall from `SessionRef<R>` stays) | Yes |
| G5 | Cross-runner session continuity is **possible but opt-in** (rooted in a conscious user decision, never implicit) | Yes |
| G6 | Subprocess runners (claude, codex) stay honest — we cannot forge CLI-native session state, so any "unified" view of them is best-effort | Yes — pragmatic |
| G7 | The store contract works for the executor's existing handle-centric wiring without a second plumbing pass | Nice-to-have |
| G8 | Observability: an auditor can read the store without importing a runner package | Nice-to-have |
| G9 | Multi-replica safe: no assumption of shared process memory | Yes for production |

---

## 4. Design Options

Four options are compared below. Each has an API sketch (≤15 LOC),
backwards-compat impact, cross-runner sharing answer, and sAIler migration
cost.

### 4.1 Option A — Adapter pattern (keep per-runner stores, add executor-level adapter)

Each runner keeps its own `SessionStore` (`ChatMessage[]`, `AnthropicMessage[]`,
etc.). A new `@ageflow/session` package defines a **`UnifiedSessionStore`**
that the executor passes down. At spawn time the executor consults the
unified store, translates to the runner-native format, calls the runner with
a thin per-spawn adapter, then translates the result back on `save`.

#### Sketch

```ts
// @ageflow/session
export interface UnifiedSessionStore {
  load(token: string): Promise<UnifiedSession | undefined>;
  save(token: string, session: UnifiedSession): Promise<void>;
  delete(token: string): Promise<void>;
}
export interface UnifiedSession {
  readonly runner: string;          // last writer's brand
  readonly messages: unknown;       // runner-typed payload
}
// Executor wires a per-runner translator:
// ApiRunner receives an InMemorySessionStore<ChatMessage> adapter
// that delegates load/save to UnifiedSessionStore, encoding/decoding.
```

| Dimension | Answer |
|---|---|
| Backwards-compat | Perfect. Nothing in runner-api changes. |
| Cross-runner sharing | **With caveats.** Only lossless when runner N is the same brand as the last writer. Otherwise the adapter must synthesize a cross-format translation (ChatMessage → AnthropicMessage), which is lossy for assistant content blocks (thinking, tool_use IDs). |
| Per-runner persistence | Adapter layered on top of per-runner store. |
| sAIler migration | Low — they keep one `SessionStore` but get a new executor option to wire it. |
| Who owns translation | Executor (or a translator registry). New surface area. |
| Subprocess runners | Not helped. Claude/codex CLIs own their state; adapter has nothing to encode/decode. |

**Pros:** least intrusive to existing runners. Keeps the strongly-typed
per-runner payload.
**Cons:** the executor now owns a runner-brand-to-message-format matrix;
cross-format translation is lossy and fragile. Two stores for the lifetime of
the deprecation (unified + per-runner) — maintenance tax. Does not help
claude/codex at all.

### 4.2 Option B — Unified protocol (runner-agnostic `Message` in core)

Lift a runner-agnostic `Message` shape into `@ageflow/core`. Define the
executor-level `SessionStore` there. All HTTP-ish runners (`api`,
`anthropic`, future `runner-*-http`) implement load/save against the unified
store and translate to their native format at the boundary (just like
`buildInitialMessages` does today,
`packages/runners/api/src/message-builder.ts:18-32`). Subprocess runners
(claude, codex) implement an empty store hook (they can still read/write the
raw `sessionHandle` as a 1-message "opaque cursor" entry, so auditors see at
least "this token resumed CLI session X").

#### Sketch

```ts
// @ageflow/core
export type Role = "system" | "user" | "assistant" | "tool";
export interface Message {
  readonly role: Role;
  readonly content: string | ReadonlyArray<ContentBlock>;
  readonly toolCalls?: ReadonlyArray<ToolCall>;
  readonly toolCallId?: string;       // tool messages
  readonly meta?: Readonly<Record<string, unknown>>;  // thinking, cache_control
}
export interface SessionStore {
  load(handle: string): Promise<ReadonlyArray<Message> | undefined>;
  save(handle: string, messages: ReadonlyArray<Message>): Promise<void>;
  delete(handle: string): Promise<void>;
}
```

| Dimension | Answer |
|---|---|
| Backwards-compat | Breaking for `ApiRunnerConfig.sessionStore` shape; provide `LegacySessionStoreAdapter` for one minor version. |
| Cross-runner sharing | **Yes, within HTTP runners.** `runner-api` ↔ `runner-anthropic` share the unified format; each runner handles its own native translation. Subprocess runners remain outside — see G6. |
| Per-runner persistence | Gone. One store, one message shape. |
| sAIler migration | Medium — they rewrite the `SessionStore` impl once, against the unified shape. Gain: a single Postgres table. |
| Who owns translation | Each runner, at the `load()` and `save()` boundary — symmetric with the existing `buildInitialMessages` / `buildAnthropicMessages` functions. |
| Subprocess runners | Best-effort — they store `{ role: "assistant", content: "", meta: { cliSessionId: "..." } }` or similar. Still lets an auditor enumerate "which tokens have been used". |

**Pros:** one concept, one shape, one deprecation. Natural extension of the
existing `buildInitialMessages` pattern. Audit and observability work
uniformly. Message semantics stay in `@ageflow/core` where the brand types
already live.
**Cons:** lossy round-tripping when a workflow bounces between anthropic and
api mid-session (thinking blocks and tool_use IDs do not survive a 1-to-1
normalized format). Adds a new public type to core. Medium migration for
sAIler.

### 4.3 Option C — Opaque token store (serialized blob per brand)

Sessions are opaque `Uint8Array` / JSON blobs keyed by `(runnerBrand, handle)`.
The store never inspects contents — only the runner that wrote them can read
them. Cross-runner sharing is explicitly **not possible** without an external
translator.

#### Sketch

```ts
// @ageflow/core
export interface SessionStore {
  load(brand: string, handle: string): Promise<Uint8Array | undefined>;
  save(brand: string, handle: string, blob: Uint8Array): Promise<void>;
  delete(brand: string, handle: string): Promise<void>;
}
// Each runner serialises its native format on save, deserialises on load.
```

| Dimension | Answer |
|---|---|
| Backwards-compat | Breaking for runner-api/anthropic constructor shape; one-off migration. |
| Cross-runner sharing | **No.** A blob written by runner-api is un-readable to runner-anthropic by construction. Consumers who want cross-runner must write a translator themselves. |
| Per-runner persistence | One store, brand-scoped keys, per-brand payloads. |
| sAIler migration | Low. Their Postgres store becomes a `(brand, handle) → bytea` table. Losing cross-runner continuity is the explicit cost. |
| Who owns translation | No one — by design. |
| Subprocess runners | Fit naturally: claude/codex save the CLI session id as a tiny JSON blob. |

**Pros:** simplest possible contract. Strongest multi-replica safety (blobs
are append-only from the store's perspective). No format lock-in in core.
Honest about runner boundaries.
**Cons:** directly contradicts the motivating sAIler use-case (#98) — a
workflow that flips `runner-api` → `runner-anthropic` mid-dialogue loses
context silently. That is the whole reason #98 exists.

### 4.4 Option D — Hybrid: opaque transport + optional translator

Adopt Option C's storage primitive (opaque blobs, brand-scoped) as the
foundational contract. Layer Option B's unified `Message` shape on top as a
**`MessageMirror`** that the executor opportunistically maintains for runners
that know how to serialize to it. Cross-runner sharing is a deliberate opt-in:
a workflow declares `session: shareAcrossRunners(token, { via: "unified" })`
and the executor plumbs the unified mirror to the next runner instead of the
native blob.

#### Sketch

```ts
// @ageflow/core
export interface SessionStore {
  load(brand: string, handle: string): Promise<SessionSnapshot | undefined>;
  save(brand: string, handle: string, snap: SessionSnapshot): Promise<void>;
  delete(brand: string, handle: string): Promise<void>;
}
export interface SessionSnapshot {
  readonly native: Uint8Array;                      // brand-scoped payload
  readonly mirror?: ReadonlyArray<Message>;         // optional unified view
}
// Executor reads .native for same-brand resume, .mirror for opt-in cross-brand.
```

| Dimension | Answer |
|---|---|
| Backwards-compat | Breaking once, with a shim for the 0.3.x → 0.4.x window. |
| Cross-runner sharing | **Yes, explicit.** Default behaviour is per-brand; cross-runner requires a DSL opt-in and is visibly lossy (mirror, not native). |
| Per-runner persistence | One store. Two views: native (exact) and mirror (normalized). |
| sAIler migration | Medium. One Postgres table with a `(brand, handle, native, mirror)` row. |
| Who owns translation | Runners own both native serialization and optional mirror emission. |
| Subprocess runners | CLI session id lives in `native`; `mirror` is a placeholder. |

**Pros:** gives us both worlds: same-brand sessions stay lossless; cross-runner
is an explicit, visible opt-in with known lossiness. Observability can read
`mirror` without caring about brand. Survives honest about subprocess
runners.
**Cons:** largest surface area to specify and document. Two parallel session
views double the runner implementation effort. "Opt-in cross-runner" DSL
syntax is new ground and will need its own bikeshed.

### 4.5 Summary comparison

| | A — Adapter | B — Unified | C — Opaque | D — Hybrid |
|---|---|---|---|---|
| Cross-runner sharing | Lossy / with caveats | Yes, lossy at block level | No | Yes, explicit opt-in |
| New core types | One (adapter) | One (`Message`, `SessionStore`) | One (`SessionStore` only) | Two (`Snapshot`, `Message`) |
| Backwards-compat cost | None | Medium | Medium | Medium |
| sAIler direct benefit | Partial | Full | Partial (loses #98 motivation) | Full |
| Subprocess runner fit | Poor | Best-effort | Natural | Natural |
| Audit / observability | Per-runner | Uniform | Blob-only | Uniform via mirror |
| Implementation effort | Medium | Medium | Low | High |
| Risk of future redesign | Medium (adapters accrete) | Low | Medium (cross-runner ask returns) | Low |

---

## 5. Recommendation

**Option B — Unified protocol.** Lift `SessionStore` and a runner-agnostic
`Message` shape into `@ageflow/core`. Every HTTP-ish runner implements
load/save at its own translation boundary (same pattern as
`buildInitialMessages` already uses). Subprocess runners get a best-effort
read/write of a CLI-session-id sentinel record.

**Confidence: 70% on B over D.** B wins on simplicity and ships the sAIler
value in a single concept; D is strictly more powerful but buys power that
nobody is concretely asking for yet. I would switch to D if within the next
release cycle a consumer demonstrates a need for lossless same-brand resume
*plus* opt-in cross-runner hops (sAIler's current ask does not — they share a
token across brands only when the brand itself is static per turn, so the
unified mirror is sufficient).

**Loss in not picking A:** we take on a real migration cost for runner-api
consumers instead of hiding it behind an adapter. **Loss in not picking C:**
we accept some lossiness at the block level (thinking/tool_use IDs do not
round-trip cleanly across brands). **Loss in not picking D:** we forgo
lossless same-brand persistence for brands that have richer native state
than the unified shape captures.

Explicitly preserved from Option D's appeal: we will document
cross-runner-sharing lossiness, rather than pretend it's invisible.

---

## 6. Phasing (Option B, 5 PRs)

Each PR is independently shippable, tested, and reviewable.

### PR 1 — `@ageflow/core`: Message + SessionStore types

- Add `Message`, `Role`, `ContentBlock`, `ToolCall` types to
  `packages/core/src/types.ts`.
- Add `SessionStore` interface + `InMemorySessionStore` impl to a new
  `packages/core/src/session.ts`.
- Export from `packages/core/src/index.ts`.
- Do **not** wire into any runner yet.
- **Success metric:** `bun run build` + new unit tests for
  `InMemorySessionStore` (load/save/delete, deep-clone isolation, parity
  with the `structuredClone` behavior of the existing runner-api store at
  `packages/runners/api/src/session-store.ts:19-23`).
- **Depends on:** nothing.

### PR 2 — `runner-api` migration (with compat shim)

- `ApiRunnerConfig.sessionStore` now accepts **both** legacy
  `SessionStore<ChatMessage>` and the new unified `SessionStore`, with a
  type guard at construction time.
- Legacy store logs a `console.warn` deprecation (keyed off process-wide flag
  so we don't spam hot paths).
- `api-runner.ts:139-141, 251` switches to: load unified `Message[]`, run
  `buildInitialMessages` over it (translate on the way in), then on save
  translate `ChatMessage[]` → `Message[]` and persist. The translator lives
  in `packages/runners/api/src/message-translator.ts` (new).
- **Success metric:** existing `runner-api` tests pass unchanged; new
  translator round-trip tests; one integration test that swaps the store
  between two `ApiRunner` instances and sees shared history.
- **Depends on:** PR 1.

### PR 3 — `runner-anthropic` migration

- Same pattern as PR 2, against Anthropic's `ContentBlock[]` shape. Thinking
  blocks map to `Message.meta.thinking`; `tool_use` / `tool_result` map to
  `ToolCall` / `Message { role: "tool" }`.
- Delete `AnthropicSessionStore` / `InMemoryAnthropicSessionStore` (or keep
  as a one-release-cycle re-export with deprecation tag).
- **Success metric:** an integration test demonstrating a `runner-api` agent
  and a `runner-anthropic` agent sharing the same unified store, with the
  second agent reading history written by the first.
  *This is the acceptance bar from #98.*
- **Prerequisite (CEO):** SessionRef brand decision (open question #1) must be
  resolved. Either widen the existing `SessionRef<R>` brand or add a parallel
  `CrossRunnerSessionRef`. PR 3 wiring depends on this decision.
- **Depends on:** PR 2.

### PR 4 — Executor-level wiring + `ExecuteOptions.sessionStore`

- Add optional `sessionStore?: SessionStore` to `ExecuteOptions` /
  `StreamOptions`.
- Pass `sessionStore` via `RunnerSpawnArgs.sessionStore` per-call. Aligns with
  the `runnerOverrides` pattern from #99. Allows different tasks in the same
  workflow to use different stores (shared default + per-tenant override).
- Update `packages/executor/src/workflow-executor.ts:238-248` to wire the
  option through and pass `sessionStore` to each `RunnerSpawnArgs`.
- Subprocess runners: record a sentinel entry `{ role: "system", content: "",
  meta: { cliSessionId: handle } }` on `save()` so auditors at least see "token
  X was active at time T under runner claude".
- **Success metric:** `execute(workflow, { sessionStore })` works end-to-end;
  sAIler example migrates to a single store.
- **Depends on:** PR 2, PR 3.

### PR 5 — Docs + SQLite reference impl

- New doc: `packages/core/README.md` section on SessionStore.
- New package `@ageflow/session-sqlite` with a reference impl using
  `bun:sqlite`. Ships the migration that sAIler can mirror for Postgres.
- Deprecation notes in `runner-api` and `runner-anthropic` READMEs.
- **Success metric:** a consumer-facing doc end-to-end, `bun run test` green
  across the monorepo, changeset entry for all affected packages.
- **Depends on:** PR 4.

**Total estimated effort:** 2-3 engineering days per PR, plus review /
iteration cycles. First three PRs land the core win; last two are polish.

---

## 7. Open Questions (need CEO / consumer input)

1. **Runner-brand wall for cross-runner sharing.** `TaskDef.session` is
   phantom-branded (`types.ts:602`). Option B's whole point is that the same
   *token* can be resumed by a different brand. Do we:
   - (a) widen the brand on `SessionRef` (compile-time wall falls);
   - (b) add a new `CrossRunnerSessionRef` that explicitly opts out of the
     wall (wall stays for the common case);
   - (c) keep the wall and say "same-token different-brand" is a runtime
     behaviour users achieve by using `unknown`-typed `SessionToken<"*">`?
   Architect's lean: **(b)**. Wall stays protective for the 95% case; the 5%
   cross-runner case is explicit and grep-able.

2. **sAIler naming (`load`/`save` vs `get`/`set`).** #120 item 2 flagged
   this. I propose adopting **`load`/`save`/`delete`** in the new interface
   in `@ageflow/core` — that's what sAIler expected and it aligns with the
   #98 proposal. The old `get`/`set` names stay on the deprecated
   `runner-api` shape. CEO sign-off?

3. **Lossy translation: block level.** Thinking blocks, Anthropic tool_use
   IDs, OpenAI tool_call IDs do not round-trip 1:1. The unified `Message`
   type either (a) keeps them in `.meta` as runner-brand-scoped opaque
   fields, or (b) loses them on translation. I recommend (a) with a documented
   "best-effort across brands" caveat. Is that acceptable for sAIler's
   dialogue archive?

4. **Multi-replica write contention.** `InMemorySessionStore` today uses
   last-write-wins semantics (`session-store.ts:22-24`). Do we want the new
   interface to admit optimistic concurrency (a `version` token on
   `load`/`save`)? I lean **no for PR 1** (don't overengineer) but **yes
   once we ship `@ageflow/session-postgres`** (PR 5+). Decision can defer.

5. **Subprocess runner sentinel records.** Worth the complexity vs. just
   "subprocess runners have no store; skip them"? sAIler currently uses only
   HTTP runners, so the subprocess hook is speculative. Defer to PR 4?

6. **Bucket vs per-token keying.** The existing executor stores one handle
   per *canonical token name* (`session-manager.ts:13`). The new store keys
   off the raw `handle: string` (which is the runtime UUID). Should the
   store know about tokens at all, or stay purely handle-addressed?
   Recommendation: stay purely handle-addressed (the executor already owns
   token → handle resolution; mixing responsibilities is a leak).

---

## 8. Non-Goals

This spec does **not** solve:

- **Conversation branching / forking.** A session is a linear transcript.
  Consumers who want to branch ("what if we rewound 3 turns and asked X?")
  implement it above the store.
- **Rollback / message deletion by ID.** No per-message identity; replaying
  from a checkpoint is outside scope.
- **Cross-process streaming of partial turns.** The unified store persists
  *completed* turns. Streaming mid-turn state (for hot failover) is a
  separate concern.
- **CLI session state round-trip for claude/codex.** We cannot ingest
  `~/.claude/projects/...` or the codex session db to recreate a mid-CLI
  conversation. Subprocess runners get a sentinel entry only.
- **Authorization / multi-tenancy.** `SessionStore` trusts its caller.
  Tenancy is a consumer concern (namespace handles with tenant IDs).
- **Replacing `SessionToken` / `ShareSessionRef`.** Those stay exactly as
  they are (`types.ts:282-302`); this spec adds the persistence layer
  *below* them.
- **A Postgres implementation.** Only the interface + SQLite reference land
  in this stream of work. sAIler continues to own their Postgres impl
  against the new interface.

---

## Appendix A — Code references

| File | Lines | Meaning |
|---|---|---|
| `packages/runners/api/src/session-store.ts` | 3-7, 14-28 | Current `SessionStore` interface + in-memory impl |
| `packages/runners/api/src/api-runner.ts` | 83-94, 139-141, 251 | Where the store is consumed |
| `packages/runners/api/src/types.ts` | 44 | `ApiRunnerConfig.sessionStore` config hook |
| `packages/runners/anthropic/src/session-store.ts` | 10-14, 21-35 | Parallel interface + impl for Anthropic |
| `packages/runners/anthropic/src/anthropic-runner.ts` | 119, 133-134, 194-196, 301 | Where the Anthropic store is consumed |
| `packages/runners/claude/src/claude-runner.ts` | 161-163, 274 | `--resume <session_id>` + session_id parse |
| `packages/runners/codex/src/codex-runner.ts` | 193-205, 248-252, 296 | `resume <THREAD_ID>` + thread_id parse |
| `packages/core/src/types.ts` | 164-193, 241-256, 282-302, 602 | `RunnerSpawnArgs.sessionHandle`, `RunnerSpawnResult.sessionHandle`, `SessionToken`, `ShareSessionRef`, `TaskDef.session` |
| `packages/executor/src/session-manager.ts` | 11, 22-53, 75-129 | Token resolution + handle lifecycle |
| `packages/executor/src/node-runner.ts` | 328-336, 392 | Handle flows into/out of the runner |
| `packages/executor/src/workflow-executor.ts` | 238-248, 593-626, 1049-1102 | Executor-owned session state per run |
| `packages/runners/api/src/message-builder.ts` | 18-32 | Existing boundary translator (the pattern we reuse in PR 2/3) |
| `packages/runners/anthropic/src/message-builder.ts` | 32-39 | Same, for Anthropic |

---

## Appendix B — Why not just export `SessionStore` from `@ageflow/runner-api`?

Tempting ("any runner that wants unified persistence depends on
runner-api"), but:

1. `@ageflow/runner-anthropic` already declares a dependency on
   `@ageflow/runner-api` for MCP re-use
   (`packages/runners/anthropic/src/anthropic-runner.ts:17-24`). Piling
   session-store ownership on top inverts the mental model: anthropic
   semantically is **not** an extension of OpenAI's Chat Completions API.
2. The type is `ChatMessage[]` — exactly the wrong shape to anoint as the
   universal one. Any cross-brand consumer would have to translate
   `AnthropicMessage → ChatMessage → AnthropicMessage` on a round trip,
   which is *more* lossy than a neutral `Message` shape.
3. `@ageflow/core` is already the home of the branded `SessionToken` /
   `ShareSessionRef` types. Putting the store there is the architecturally
   correct location — all session concepts in one package.
