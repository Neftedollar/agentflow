# AgentFlow — Design Spec

## Context

Нужна система для написания чётких, воспроизводимых workflow-инструкций для AI-агентов (claude-cli, codex, qwen и др.). Сейчас нет стандартного способа описывать multi-agent пайплайны — с типизацией, HITL, управлением сессиями и гарантией завершения.

**Цель:** embedded TypeScript DSL + local CLI executor. Аналог Pulumi для агентных workflow — не YAML, а настоящий язык с типами, который выполняется.

---

## Архитектура — 4 слоя

```
┌─────────────────────────────────────────────────┐
│  Workflow file  (my-workflow.ts)                │  ← пишет пользователь
│  defineAgent + defineWorkflow + loop            │
├─────────────────────────────────────────────────┤
│  @agentflow/core                                │  ← типы, Zod-схемы, builders
│  AgentDef<I,O> · WorkflowDef · HITLConfig       │
├─────────────────────────────────────────────────┤
│  @agentflow/runners/{claude,codex,qwen}         │  ← знают как спавнить CLI
├─────────────────────────────────────────────────┤
│  @agentflow/executor                            │  ← DAG, subprocess, HITL
└─────────────────────────────────────────────────┘
```

**Принципы:**
- `@agentflow/core` — zero-runtime (типы + Zod), нет зависимости на executor
- Runners — сменные адаптеры; добавить провайдер = написать один адаптер
- Workflow-файл запускается напрямую: `bun run workflow.ts`

---

## Monorepo структура

```
agentflow/
  packages/
    core/          # @agentflow/core
    executor/      # @agentflow/executor
    runners/
      claude/      # @agentflow/runners/claude
      codex/       # @agentflow/runners/codex
      qwen/        # @agentflow/runners/qwen
    cli/           # agentflow CLI (agentwf run / agentwf validate)
  examples/
    bug-fix-pipeline/
```

---

## DSL Core — типы и API

### defineAgent

`hitl` и `retry` задаются в `defineAgent` как дефолты для агента. Переопределить для конкретного task можно прямо в workflow: `tasks.fix.hitl` перекрывает агентный дефолт. Task-level конфиг всегда приоритетнее.



```ts
import { z } from "zod"
import { defineAgent } from "@agentflow/core"

const analyzeAgent = defineAgent({
  runner: "claude",
  model: "claude-opus-4-6",
  input: z.object({
    repoPath: z.string(),
  }),
  output: z.object({
    issues: z.array(z.object({
      file: z.string(),
      description: z.string(),
      line: z.number().optional(),
    })),
  }),
  prompt: ({ repoPath }) => `Analyze ${repoPath} for bugs and issues`,
  tools: ["read_file", "list_dir"],
  skills: ["code-reviewer"],
  mcps: [{ server: "filesystem", args: ["--root", "."] }],
  hitl: {
    mode: "checkpoint",
    message: "Review findings before proceeding",
  },
  retry: {
    max: 3,
    on: ["subprocess_error", "output_validation_error"],
    backoff: "exponential",   // 1s, 2s, 4s
  },
})
```

### defineWorkflow — полный пример

```ts
import { defineWorkflow, loop, sessionToken } from "@agentflow/core"

const sharedCtx = sessionToken("analysis-context")

export default defineWorkflow({
  name: "bug-fix-pipeline",
  tasks: {
    // Обычный task — запускается один раз
    analyze: {
      agent: analyzeAgent,
      input: { repoPath: "./src" },
      session: sharedCtx,
    },

    // Loop — крутит subgraph пока условие не выполнено
    fixLoop: loop({
      dependsOn: ["analyze"],
      max: 5,
      until: (ctx) => ctx.eval.output.satisfied === true,
      context: "persistent",   // "persistent" (default) | "fresh" — сессия между итерациями
      input: (ctx) => ({ issues: ctx.analyze.output.issues }),
      tasks: {
        fix: {
          agent: fixAgent,
          input: (ctx) => ({
            issues: ctx.loop.input.issues,
            feedback: ctx.eval?.output?.feedback,  // фидбек с прошлой итерации
          }),
          hitl: {
            mode: "permissions",
            permissions: {
              write_file: true,
              run_tests: true,
              deploy: false,   // всегда требует человека
            },
          },
        },
        eval: {
          agent: evalAgent,
          dependsOn: ["fix"],
          input: (ctx) => ({ patches: ctx.fix.output.patches }),
        },
      },
    }),

    // Финальный task — после loop
    summarize: {
      agent: summarizeAgent,
      dependsOn: ["analyze", "fixLoop"],
      session: sharedCtx,   // та же сессия — контекст без затрат токенов
      input: (ctx) => ({
        issues: ctx.analyze.output.issues,        // typed
        patches: ctx.fixLoop.output.fix.patches,  // typed
      }),
    },
  },
})
```

### Мульти-провайдер

```ts
tasks: {
  analyze:  { agent: defineAgent({ runner: "claude",  ... }) },
  fix:      { agent: defineAgent({ runner: "codex",   ... }) },
  summarize:{ agent: defineAgent({ runner: "qwen",    ... }) },
}
```

---

## Session management

Два паттерна:

```ts
// 1. Прямая ссылка — транзитивная
summarize: { session: shareSessionWith("analyze") }
// если analyze → shareSessionWith("setup"), все три получают одну сессию

// 2. Именованная группа — явная, для 3+ участников
const ctx = sessionToken("shared")
analyze:   { session: ctx }
summarize: { session: ctx }
report:    { session: ctx }
```

Агенты разных провайдеров в одной сессии → warning (cross-provider сессия бессмысленна технически).

---

## Executor

### Pre-flight validation

Запускается автоматически перед каждым `run`. Отдельно: `agentwf validate workflow.ts`.

Проверяет:
- CLI runners установлены (`which claude`, `which codex`, ...)
- MCP серверы доступны (ping по socket/port)
- Skills существуют в `~/.claude/plugins/...`
- Env vars объявленные в runner как `required`
- DAG валиден (нет циклов, все `dependsOn` резолвятся)
- Session refs валидны (цепочки `shareSessionWith` резолвируются в flat map)

```
[pre-flight] Validating "bug-fix-pipeline"...
  ✓ claude CLI found (v1.2.3)
  ✗ qwen CLI not found — install: brew install qwen-cli
  ✓ MCP "filesystem" available
  ✗ MCP "github" not running
  ✗ ANTHROPIC_API_KEY not set
[pre-flight] 3 errors. Fix before running.
```

### Выполнение узла

```
spawn subprocess (runner adapter)
  → timeout?              → retry
  → exit code != 0?       → retry
  → parse stdout as JSON  → fail? → retry
  → zod.parse(output)     → fail? → retry
  → success               → передать typed output downstream
```

После `retry.max` → `NodeMaxRetriesError` с историей попыток.

### Loop execution

```
iteration 1: run inner DAG → check until() → false → pass feedback
iteration 2: run inner DAG → check until() → true  → exit, return last output
```

При `context: "persistent"` runner передаёт session handle между итерациями.  
При достижении `max` → `LoopMaxIterationsError`.

---

## HITL modes

| Mode | Поведение |
|------|-----------|
| `off` | Полностью автономный |
| `permissions` | Проверяет map перед каждым tool call. `false` → блокирует |
| `checkpoint` | Останавливает граф, ждёт явного апрува пользователя |

---

## Runner Adapter interface

```ts
interface Runner {
  validate(): Promise<{ ok: boolean; version?: string; error?: string }>
  spawn(args: {
    prompt: string
    model?: string
    tools?: string[]
    skills?: string[]
    mcps?: MCPConfig[]
    sessionHandle?: string
    permissions?: Record<string, boolean>
  }): Promise<{ stdout: string; sessionHandle: string }>
}
```

Каждый runner знает флаги своего CLI и формат вывода.

---

## v2 — Agent-specific SDKs (не в v1)

```ts
// v2: typed builder вместо строк
claude.agent({
  tools: t => [t.readFile, t.listDir],
  skills: s => [s.codeReviewer],
})
```

---

## Верификация

1. `bun run examples/bug-fix-pipeline/workflow.ts` — end-to-end с mock CLI (stdout-моки вместо реальных агентов)
2. `agentwf validate examples/bug-fix-pipeline/workflow.ts` — pre-flight без запуска
3. Unit тесты: DAG topological sort, session chain resolution, pre-flight validator, retry logic
4. TypeScript compile-time: намеренные ошибки типов в `ctx.*.output` должны не компилироваться

---

## Название / пакеты

- Проект: **agentflow**
- Пакеты: `@agentflow/core`, `@agentflow/executor`, `@agentflow/runners/*`, `agentflow` (CLI)
- Проверить npm: `npm info agentflow`
