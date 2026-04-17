import type { ZodType } from "zod";

// ─── Error kinds ──────────────────────────────────────────────────────────────

export type RetryErrorKind =
  | "subprocess_error"
  | "output_validation_error"
  | "tool_not_used"
  | "timeout"
  | "rate_limit"
  | "provider_unavailable"
  | "budget_exceeded"
  | "agent_hitl_conflict"
  | "mcp_server_start_failed";

// ─── Config types ─────────────────────────────────────────────────────────────

export type HITLMode = "off" | "permissions" | "checkpoint";

/**
 * HITL (Human-In-The-Loop) configuration.
 * - "off": fully autonomous
 * - "permissions": static tool allowlist at spawn time. Tools not listed are DENIED by default.
 * - "checkpoint": executor pauses before task, waits for explicit user approval
 */
export type HITLConfig =
  | { readonly mode: "off" }
  | {
      readonly mode: "permissions";
      /**
       * Allowlist of tools. Any tool not listed here is DENIED.
       * Deny-by-default when mode is "permissions".
       */
      readonly permissions: Readonly<Record<string, boolean>>;
    }
  | {
      readonly mode: "checkpoint";
      readonly message?: string;
    };

export interface RetryConfig {
  readonly max: number;
  readonly on: readonly RetryErrorKind[];
  readonly backoff: "exponential" | "linear" | "fixed";
  /** Timeout per attempt in ms. Default: 300_000 (5 min). */
  readonly timeoutMs?: number;
}

export interface BudgetConfig {
  /** Maximum cost in USD. */
  readonly maxCost: number;
  readonly onExceed: "halt" | "warn";
}

export interface MCPConfig {
  /** Static identifier: must match /^[a-zA-Z0-9._-]+$/. */
  readonly server: string;
  readonly args?: readonly string[];
  readonly autoStart?: boolean;
}

// ─── MCP server config (v0.2) ─────────────────────────────────────────────────

export interface McpServerConfig {
  /** Stable identifier, /^[a-zA-Z0-9._-]+$/. Used as tool-name prefix. */
  readonly name: string;
  /** Executable. Static — no function forms. */
  readonly command: string;
  readonly args?: readonly string[];
  /** Env vars. `${env:X}` substitution resolved at launch time. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory. Default: executor cwd. */
  readonly cwd?: string;
  /**
   * Tool allowlist. When omitted, all tools exposed by the server are
   * allowed. When present, tools not in the list are filtered out
   * before reaching the model AND rejected if the model calls them.
   */
  readonly tools?: readonly string[];
  /**
   * Per-tool argument refinement. Maps tool name → Zod schema run before
   * the call is dispatched. Lets users pin `safePath()` on path args.
   */
  // biome-ignore lint/suspicious/noExplicitAny: must accept any ZodType shape
  readonly refine?: Readonly<Record<string, import("zod").ZodType<any>>>;
  /** Transport — v0.2 only supports "stdio". Typed open for v0.3+. */
  readonly transport?: "stdio";
  /** Per-call timeout. Default 30 s. */
  readonly mcpCallTimeoutMs?: number;
  /**
   * API runner: keep this MCP server alive across `spawn()` calls on
   * the same runner instance. CLI runners ignore (lifecycle delegated
   * to the CLI). Default false.
   */
  readonly reusePerRunner?: boolean;
}

export interface AgentMcpConfig {
  readonly servers: readonly McpServerConfig[];
  /** true → append to workflow.mcp.servers; false (default) → replace. */
  readonly extendWorkflow?: boolean;
}

export interface TaskMcpOverride {
  /** Whitelist by name — keep only these resolved servers. */
  readonly servers: readonly string[];
}

/** Minimal logger interface for executor/hook injection. */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

// ─── Runner interface ─────────────────────────────────────────────────────────

export interface RunnerSpawnArgs {
  prompt: string;
  model?: string;
  tools?: readonly string[];
  skills?: readonly string[];
  /** Resolved MCP servers, post-workflow/agent/task merging. */
  mcpServers?: readonly McpServerConfig[];
  /** @deprecated old v0.1 shape — preserved during migration window. */
  mcps?: readonly MCPConfig[];
  sessionHandle?: string;
  permissions?: Readonly<Record<string, boolean>>;
  /**
   * System prompt injected by the executor (JSON schema contract + sanitize directives).
   * Runners MUST prepend this BEFORE the user prompt.
   */
  systemPrompt?: string;
  /**
   * Logical task name that triggered this spawn call.
   * Passed by the executor so runners and test harnesses can route by task
   * without relying on shared mutable state (safe under parallel execution).
   */
  taskName?: string;
}

/**
 * Observability record for a single tool invocation performed by a runner.
 * Non-normative — runners that do not perform tool calls omit this.
 */
export interface ToolCallRecord {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly durationMs: number;
}

export interface RunnerSpawnResult {
  /**
   * Raw UNTRUSTED stdout. The executor MUST zod.parse() against AgentDef.output
   * before any downstream use. Never pass raw stdout to other agents.
   */
  readonly stdout: string;
  readonly sessionHandle: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /**
   * Tool-call observability trail. Runners that do not perform tool calls
   * (e.g. subprocess runners) MAY omit this. Executor passes through to
   * `TaskMetrics` / `ExecutionTrace` when present.
   */
  readonly toolCalls?: readonly ToolCallRecord[];
}

/**
 * Runner adapter interface. Each runner knows the flags of its CLI and output format.
 * Runners are schema-agnostic — they return raw stdout; executor handles parsing.
 */
export interface Runner {
  validate(): Promise<{ ok: boolean; version?: string; error?: string }>;
  spawn(args: RunnerSpawnArgs): Promise<RunnerSpawnResult>;
  /**
   * Optional cleanup hook. Runners holding long-lived resources (e.g. the
   * API runner's per-runner MCP pool) drain them here. Invoked by the
   * workflow executor on completion / abort.
   */
  shutdown?(): Promise<void>;
}

// ─── Session types (phantom-branded) ─────────────────────────────────────────

declare const __runnerBrand: unique symbol;

/**
 * Named session group. Phantom-branded by runner type R.
 * Passing this to an agent with a different runner brand is a compile-time error.
 */
export interface SessionToken<R extends string = string> {
  readonly kind: "token";
  readonly name: string;
  /** @internal phantom brand — never set at runtime */
  readonly [__runnerBrand]?: R;
}

/**
 * Transitive session ref — inherits the runner brand of the referenced task.
 * Cross-provider session sharing is a compile-time error.
 */
export interface ShareSessionRef<R extends string = string> {
  readonly kind: "share";
  readonly taskName: string;
  /** @internal phantom brand — never set at runtime */
  readonly [__runnerBrand]?: R;
}

export type SessionRef<R extends string = string> =
  | SessionToken<R>
  | ShareSessionRef<R>;

// ─── Agent definition ─────────────────────────────────────────────────────────

/**
 * Defines an AI agent with typed I/O and execution configuration.
 *
 * SECURITY: `output` is the Zod security boundary. Everything outside the schema
 * is discarded. Prefer precise object schemas over z.any()/z.string().
 *
 * SECURITY: `sanitizeInput` (default true) controls whether the executor sanitizes
 * ctx.*.output data before interpolating into prompts. Do not disable unless
 * upstream schema guarantees data is safe.
 */
export interface AgentDef<
  I extends ZodType = ZodType,
  O extends ZodType = ZodType,
  R extends string = string,
> {
  /** Runner identifier. Must match /^[a-zA-Z0-9._-]+$/. Static value only — no functions. */
  readonly runner: R;
  /** Model identifier. Static value only — no functions. */
  readonly model?: string;
  readonly input: I;
  /**
   * Output schema. REQUIRED. This is the security boundary — executor parses
   * raw stdout through this schema; unparsed content is discarded.
   */
  readonly output: O;
  readonly prompt: (input: import("zod").infer<I>) => string;
  /** Tool identifiers. Static values only — no functions. */
  readonly tools?: readonly string[];
  /** Skill identifiers. Static values only — no functions. */
  readonly skills?: readonly string[];
  /** MCP server configuration (v0.2). */
  readonly mcp?: AgentMcpConfig;
  /**
   * @deprecated use `mcp.servers` — kept for v0.1 backward compatibility.
   * Will be removed in a future major version.
   */
  readonly mcps?: readonly MCPConfig[];
  readonly hitl?: HITLConfig;
  readonly retry?: Partial<RetryConfig>;
  /**
   * Sanitize ctx.*.output data before prompt interpolation.
   * Default: true. Setting false disables prompt-injection sanitization.
   * @defaultValue true
   */
  readonly sanitizeInput?: boolean;
  readonly mustUse?: readonly string[];
  /** Per-agent timeout in ms (single run, not per retry). Default: 300_000 (5 min). */
  readonly timeoutMs?: number;
  /**
   * Environment variable passthrough. Default: inherit all (v1).
   * Narrowing is supported but not enforced in v1.
   */
  readonly env?: {
    readonly pass?: readonly string[];
    readonly scrub?: readonly (string | RegExp)[];
  };
  /** Max stdout bytes before output_validation_error. Default: 1_048_576 (1 MB). */
  readonly maxOutputBytes?: number;
  /**
   * Fallback chain. v2 feature — typed here to prevent breaking API changes.
   * @v2
   */
  readonly fallback?: never;
}

/**
 * AgentDef with all defaults resolved. Consumed by the executor — never raw AgentDef.
 * Executors MUST use resolveAgentDef() to get this type.
 */
export interface ResolvedAgentDef<
  I extends ZodType = ZodType,
  O extends ZodType = ZodType,
  R extends string = string,
> extends Omit<
    AgentDef<I, O, R>,
    "sanitizeInput" | "retry" | "timeoutMs" | "maxOutputBytes"
  > {
  /** Always explicitly set to true or false after resolveAgentDef(). */
  readonly sanitizeInput: boolean;
  readonly retry: RetryConfig;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

// ─── Task map types ───────────────────────────────────────────────────────────

export type TasksMap = Record<
  string,
  // biome-ignore lint/suspicious/noExplicitAny: structural constraint — any AgentDef shape
  TaskDef<AgentDef<any, any, any>, readonly string[]> | LoopDef<TasksMap>
>;

/**
 * Extract the runner brand from an AgentDef.
 * RunnerOf<AgentDef<any, any, "claude">> = "claude"
 *
 * Uses property-based extraction to avoid TypeScript interface variance issues
 * with conditional `extends AgentDef<...>` matching.
 */
export type RunnerOf<A> = A extends { runner: infer R extends string }
  ? R
  : never;

/**
 * Extract the output Zod type from an AgentDef.
 */
export type OutputZodOf<A> = A extends AgentDef<ZodType, infer O, string>
  ? O
  : never;

/**
 * Extract the typed output from an AgentDef.
 */
export type OutputOf<A> = A extends { output: infer O extends ZodType }
  ? import("zod").infer<O>
  : never;

/**
 * Extract the typed input from an AgentDef.
 */
export type InputOf<A> = A extends { input: infer I extends ZodType }
  ? import("zod").infer<I>
  : never;

/**
 * Extract the runner brand from a task in a TasksMap.
 * RunnerOfTask<T, K> = RunnerOf<T[K]["agent"]>
 */
export type RunnerOfTask<
  T extends TasksMap,
  K extends keyof T,
> = T[K] extends TaskDef<infer A, readonly string[]> ? RunnerOf<A> : never;

/**
 * Extract the direct dependsOn keys of task K in workflow T.
 */
export type DependsOnOf<
  T extends TasksMap,
  K extends keyof T,
> = T[K] extends TaskDef<
  // biome-ignore lint/suspicious/noExplicitAny: structural infer
  AgentDef<any, any, any>,
  infer D extends readonly string[]
>
  ? D[number] & keyof T
  : never;

/**
 * Context available inside a task's `input` function.
 * Only tasks listed in `dependsOn` are accessible.
 * Loop outputs are typed as unknown (v1 known limitation).
 */
export type CtxFor<T extends TasksMap, K extends keyof T> = {
  readonly [P in DependsOnOf<T, K>]: T[P] extends TaskDef<
    infer A,
    readonly string[]
  >
    ? {
        readonly output: OutputOf<A>;
        /** Source discriminant for executor sanitization decisions. */
        readonly _source: "agent";
      }
    : T[P] extends LoopDef<TasksMap>
      ? {
          /**
           * Loop output type is unknown in v1 (known limitation).
           * Cast: (ctx.myLoop.output as { taskName: { field: Type } }).taskName.field
           */
          readonly output: unknown;
          readonly _source: "loop";
        }
      : never;
};

// ─── Task definition ──────────────────────────────────────────────────────────

/**
 * Typed ctx available inside a task's `input` function.
 * Restricts access to only declared `dependsOn` keys.
 * Output is `unknown` — cast to the expected type or use `CtxFor<T, K>` for full typing.
 *
 * Requires `dependsOn: [...] as const` to get key-level enforcement.
 * Without `as const`, D[number] = string and all keys are accepted (no enforcement).
 */
export type BoundCtx<D extends readonly string[]> = {
  readonly [P in D[number]]: {
    readonly output: unknown;
    readonly _source: string;
  };
};

/**
 * A single task in a workflow.
 *
 * @typeParam A - Agent definition
 * @typeParam D - Tuple of dependsOn task keys (`as const` required for type enforcement)
 *
 * Type safety levels for the `input` callback:
 * - With `dependsOn: ["a", "b"] as const` → ctx restricted to keys "a" | "b", output is unknown
 * - Without `as const` → no key restriction (falls back to string index)
 * - For fully-typed output use `CtxFor<typeof workflow.tasks, "taskName">` directly
 */
export interface TaskDef<
  // biome-ignore lint/suspicious/noExplicitAny: structural constraint — any AgentDef shape
  A extends AgentDef<any, any, any> = AgentDef<any, any, any>,
  D extends readonly string[] = readonly string[],
> {
  readonly agent: A;
  readonly dependsOn?: D;
  readonly input?:
    | import("zod").infer<
        A extends { input: infer I extends ZodType } ? I : never
      >
    | ((
        ctx: BoundCtx<D>,
      ) => import("zod").infer<
        A extends { input: infer I extends ZodType } ? I : never
      >);
  readonly session?: SessionRef<RunnerOf<A>>;
  readonly hitl?: HITLConfig;
  readonly mustUse?: readonly string[];
  /** Override which resolved MCP servers are available for this specific task. */
  readonly mcpOverride?: TaskMcpOverride;
}

// ─── Loop definition ──────────────────────────────────────────────────────────

export type LoopContext = "persistent" | "fresh";

export interface LoopDef<T extends TasksMap = TasksMap> {
  readonly kind: "loop";
  readonly dependsOn?: readonly string[];
  readonly max: number;
  readonly until: (ctx: unknown) => boolean;
  readonly context?: LoopContext;
  readonly input?: ((ctx: unknown) => unknown) | unknown;
  readonly tasks: T;
  /**
   * Context window limit. Advisory in v1 — executor may not enforce.
   * @v1advisory
   */
  readonly contextLimit?: number;
}

// ─── Workflow types ───────────────────────────────────────────────────────────

export interface TaskMetrics {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly retries: number;
  /** Estimated USD cost based on model and token counts. */
  readonly estimatedCost: number;
  /** The full prompt as sent to the runner (including any injected prefixes). */
  readonly promptSent?: string;
}

export interface WorkflowMetrics {
  readonly totalLatencyMs: number;
  readonly totalTokensIn: number;
  readonly totalTokensOut: number;
  readonly totalEstimatedCost: number;
  readonly taskCount: number;
}

export interface WorkflowHooks<T extends TasksMap = TasksMap> {
  readonly onTaskStart?: (taskName: keyof T & string) => void;
  readonly onTaskComplete?: (
    taskName: keyof T & string,
    output: unknown,
    metrics: TaskMetrics,
  ) => void;
  readonly onTaskError?: (
    taskName: keyof T & string,
    error: Error,
    attempt: number,
  ) => void;
  /**
   * Called when a checkpoint HITL gate is reached.
   * Use this to send Telegram/Slack notifications before proceeding.
   */
  readonly onCheckpoint?: (taskName: keyof T & string, message: string) => void;
  readonly onWorkflowComplete?: (
    result: unknown,
    summary: WorkflowMetrics,
  ) => void | Promise<void>;
  /**
   * Returns extra context to prepend to the agent's system prompt.
   * Called before each task spawn. Learning hooks use this to inject skills.
   * Generic — useful beyond learning (per-task instructions, env context).
   */
  readonly getSystemPromptPrefix?: (
    taskName: keyof T & string,
  ) => string | undefined | Promise<string | undefined>;
}

// ─── MCP exposure config ─────────────────────────────────────────────────────

/**
 * Configuration for exposing a workflow as an MCP tool via @ageflow/mcp-server.
 *
 * Authors declare hard ceilings here — operators can only *lower* them via CLI.
 * Use `null` on an individual ceiling to opt out of that specific limit, or
 * `limits: "unsafe-unlimited"` as shorthand for all three.
 *
 * Set `mcp: false` on the workflow to explicitly forbid MCP exposure.
 */
export interface McpConfig {
  /** Tool description surfaced to MCP clients. Defaults to "Run ageflow workflow: ${name}". */
  readonly description?: string;
  /** Hard cost ceiling in USD. `null` = unlimited. Default: 1.00. */
  readonly maxCostUsd?: number | null;
  /** Hard duration ceiling in seconds. `null` = unlimited. Default: 300. */
  readonly maxDurationSec?: number | null;
  /** Hard retry/loop-turn ceiling. `null` = unlimited. Default: 20. */
  readonly maxTurns?: number | null;
  /** Shorthand to disable all three ceilings. Requires exact literal "unsafe-unlimited". */
  readonly limits?: "unsafe-unlimited";
  /** Name of the task whose input becomes the tool's inputSchema. Required if DAG has >1 root. */
  readonly inputTask?: string;
  /** Name of the task whose output becomes the tool's outputSchema. Required if DAG has >1 leaf. */
  readonly outputTask?: string;
}

export interface WorkflowDef<T extends TasksMap = TasksMap> {
  readonly name: string;
  readonly tasks: T;
  readonly hooks?: WorkflowHooks<T>;
  readonly budget?: BudgetConfig;
  /**
   * MCP exposure config. Set to `false` to forbid MCP exposure,
   * omit for safe defaults, or provide a `McpConfig` to customize.
   * (workflow AS MCP server — #18)
   */
  readonly mcp?: McpConfig | false;
  /**
   * MCP servers the workflow's agents MAY use (#19).
   * Agent-level `mcp.servers` can extend or replace this list.
   */
  readonly mcpServers?: readonly McpServerConfig[];
  /**
   * Environment profiles. v2 feature — type reserved to prevent breaking API changes.
   * @v2
   */
  readonly profiles?: never;
}

// ─── Run state + events ──────────────────────────────────────────────────────

export type RunState =
  | "running"
  | "awaiting-checkpoint"
  | "done"
  | "failed"
  | "cancelled";

interface EventBase {
  readonly runId: string;
  readonly workflowName: string;
  /** Date.now() at the moment the event was emitted. */
  readonly timestamp: number;
}

export interface WorkflowStartEvent extends EventBase {
  readonly type: "workflow:start";
  readonly input: unknown;
}

export interface TaskStartEvent extends EventBase {
  readonly type: "task:start";
  readonly taskName: string;
}

export interface TaskCompleteEvent extends EventBase {
  readonly type: "task:complete";
  readonly taskName: string;
  readonly output: unknown;
  readonly metrics: TaskMetrics;
}

export interface TaskErrorEvent extends EventBase {
  readonly type: "task:error";
  readonly taskName: string;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
  readonly attempt: number;
  /** true when retries exhausted or the error kind is non-retryable. */
  readonly terminal: boolean;
}

export interface TaskRetryEvent extends EventBase {
  readonly type: "task:retry";
  readonly taskName: string;
  /** The attempt that is about to start (0-indexed, matches node-runner). */
  readonly attempt: number;
  readonly reason: string;
}

export interface CheckpointEvent extends EventBase {
  readonly type: "checkpoint";
  readonly taskName: string;
  readonly message: string;
}

export interface BudgetWarningEvent extends EventBase {
  readonly type: "budget:warning";
  readonly spentUsd: number;
  readonly limitUsd: number;
}

export interface WorkflowCompleteEvent extends EventBase {
  readonly type: "workflow:complete";
  readonly result: {
    readonly outputs: Record<string, unknown>;
    readonly metrics: WorkflowMetrics;
  };
}

export interface WorkflowErrorEvent extends EventBase {
  readonly type: "workflow:error";
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
}

export type WorkflowEvent =
  | WorkflowStartEvent
  | TaskStartEvent
  | TaskCompleteEvent
  | TaskErrorEvent
  | TaskRetryEvent
  | CheckpointEvent
  | BudgetWarningEvent
  | WorkflowCompleteEvent
  | WorkflowErrorEvent;

/**
 * Public, JSON-serializable snapshot of a run. Returned by
 * `Runner.get()` / `Runner.fire()` / `Runner.list()`.
 */
export interface RunHandle {
  readonly runId: string;
  readonly state: RunState;
  readonly workflowName: string;
  readonly createdAt: number;
  readonly lastEventAt: number;
  /** Present only when state === "awaiting-checkpoint". */
  readonly pendingCheckpoint?: CheckpointEvent;
  /** Present only when state === "done". */
  readonly result?: {
    readonly outputs: Record<string, unknown>;
    readonly metrics: WorkflowMetrics;
  };
  /** Present only when state === "failed". */
  readonly error?: { readonly name: string; readonly message: string };
}
