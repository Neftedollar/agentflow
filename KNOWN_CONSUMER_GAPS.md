# Known Consumer Gaps

Tracking register for "accepted as design" / "workaround" items flagged by ageflow consumers.
Each gap surfaces from a real consumer's NOTES.md or feedback channel; we either close it upstream
or label it `wont-fix` with reasoning.

## How entries work

Each row: consumer name, date flagged, gap description, current workaround, status.

| Status legend |
|---|
| 🟡 open — accepted, not yet addressed |
| 🟢 closed-in-#NN — fixed upstream, consumer should bump |
| ❌ wont-fix — explicit decision, see linked ADR |

---

## sAIler — dev-workflow (Apr 17, 2026)

Source: `dev-workflow/NOTES.md` "Ageflow API decisions (ageflow#120 triage)".

| # | Gap | Workaround | Status |
|---|-----|-----------|--------|
| 2 | `SessionStore` API: `get/set/delete` (not `load/save`); type `ChatMessage` (not `Message`) | Accept naming | ❌ wont-fix (naming preference) |
| 3 | `BudgetTracker` no callback; halt is declarative via `WorkflowDef.budget` | Declare `.budget` per pipeline | 🟢 closed-in-#132 (`onExceeded` callback) |
| 4 | `defineAgent` has no `session`; sessions at TaskDef level | Set `session:` on tasks; `makeAgent` doesn't forward | 🟡 open — pending CEO decision (#127) |
| 5 | `AgentDef.tools: readonly string[]` — no inline defs | Tool name strings only | 🟢 closed-in-#158 (inline tool defs) |
| 6 | No `skipIf` on TaskDef | SHIP task reads gate from taskContext; reviewers run unconditionally | 🟢 closed-in-#129 |
| 7 | `(ctx: any)` in pipeline callbacks; `$input/$parent/$prev` are runtime-only | Document and live with it | 🟢 closed-in-#146 (docs + JSDoc) |

---

## How to add an entry

1. Consumer flags the gap in their notes / a GH issue.
2. Open an issue here with `consumer-feedback` label, linking the source.
3. Add a row to the table above with the issue number.
4. Triage: close upstream OR mark wont-fix with rationale.
5. When closed, update status + the consumer's tracking issue (if any) so they know to bump.

## Cadence

Biweekly review (orchestrator):
- Check each consumer's published-version pin.
- For each closed item, post a tracking comment in the consumer's repo if their pin is below the closing version.
- Goal: zero consumers running on out-of-date "accepted" gaps.
