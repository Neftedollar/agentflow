import type { ZodType } from "zod";
import { validateStaticIdentifier } from "./schemas.js";
import type {
  AgentDef,
  AgentMcpConfig,
  FunctionDef,
  LoopDef,
  MCPConfig,
  McpServerConfig,
  ResolvedAgentDef,
  RetryConfig,
  Runner,
  RunnerOfTask,
  SessionToken,
  ShareSessionRef,
  TasksMap,
  WorkflowDef,
} from "./types.js";

/** In-memory runner registry. Used by executor to find runner implementations. */
const _runnerRegistry = new Map<string, Runner>();

/**
 * Define an AI agent with typed I/O and execution configuration.
 *
 * @example
 * const analyzeAgent = defineAgent({
 *   runner: "claude",
 *   model: "claude-opus-4-6",
 *   input: z.object({ repoPath: safePath() }),
 *   output: z.object({ issues: z.array(z.string()) }),
 *   prompt: ({ repoPath }) => `Analyze ${repoPath} for issues`,
 * });
 */
export function defineAgent<
  I extends ZodType,
  O extends ZodType,
  const R extends string,
>(config: AgentDef<I, O, R>): AgentDef<I, O, R> {
  // Validate static identifiers at definition time
  validateStaticIdentifier(config.runner, "runner");
  if (config.model !== undefined) {
    validateStaticIdentifier(config.model, "model");
  }
  for (const mcp of config.mcps ?? []) {
    validateStaticIdentifier(mcp.server, "mcp.server");
  }

  // Warn if output schema is z.any() / z.unknown() — security boundary would be bypassed
  // biome-ignore lint/suspicious/noExplicitAny: internal type inspection
  const typeName = (config.output as any)._def?.typeName;
  if (typeName === "ZodAny" || typeName === "ZodUnknown") {
    console.warn(
      `[agentflow] defineAgent runner="${config.runner}": output schema is ${typeName} — prompt injection from agent stdout will pass through to downstream agents unsanitized. Use a specific Zod object schema.`,
    );
  }

  return config;
}

/**
 * Define a deterministic, non-LLM function step for use in a workflow DAG.
 *
 * Function tasks have the same DAG semantics as agent tasks (zod validation,
 * retry, skipIf, dependsOn, CtxFor, loop participation, event emission)
 * but execute a plain async function — no runner, no budget, no session.
 *
 * @example
 * const snapshotStep = defineFunction({
 *   name: "snapshot",
 *   input: z.object({ userId: z.string() }),
 *   output: z.object({ data: z.any() }),
 *   execute: async (input) => ({ data: await fetchData(input.userId) }),
 * });
 *
 * defineWorkflow({
 *   tasks: {
 *     snapshot: { fn: snapshotStep, input: (ctx) => ({ userId: "u1" }) },
 *     interpret: {
 *       agent: interpretAgent,
 *       dependsOn: ["snapshot"],
 *       input: (ctx) => ({ data: ctx.snapshot.output.data }),
 *     },
 *   },
 * });
 */
export function defineFunction<I extends ZodType, O extends ZodType>(args: {
  name?: string;
  input: I;
  output: O;
  execute: (input: import("zod").infer<I>) => Promise<import("zod").infer<O>>;
}): FunctionDef<I, O> {
  const def: FunctionDef<I, O> = {
    _tag: "function",
    inputSchema: args.input,
    outputSchema: args.output,
    execute: args.execute,
  };
  // exactOptionalPropertyTypes: only set when defined
  if (args.name !== undefined) {
    (def as { name?: string }).name = args.name;
  }
  return def;
}

const DEFAULT_RETRY: RetryConfig = {
  max: 3,
  on: ["subprocess_error", "output_validation_error"],
  backoff: "exponential",
  timeoutMs: 300_000,
};

/**
 * Migrate a legacy MCPConfig entry to the new McpServerConfig shape.
 * Best-effort: command defaults to "npx" with inferred args when not available
 * in the legacy shape. Users should migrate to `mcp.servers` for full control.
 *
 * @internal
 */
function migrateLegacyMcpEntry(legacy: MCPConfig): McpServerConfig {
  const config: McpServerConfig = {
    name: legacy.server,
    // v0.1 MCPConfig had no `command` field — default to npx
    command: "npx",
  };
  if (legacy.args !== undefined) {
    // exactOptionalPropertyTypes: only set when defined
    return { ...config, args: legacy.args };
  }
  return config;
}

/**
 * Resolve an AgentDef to its fully-defaulted form for executor consumption.
 * Executors MUST consume ResolvedAgentDef — never raw AgentDef.
 */
export function resolveAgentDef<
  I extends ZodType,
  O extends ZodType,
  R extends string,
>(def: AgentDef<I, O, R>): ResolvedAgentDef<I, O, R> {
  const resolvedRetry: RetryConfig = {
    max: def.retry?.max ?? DEFAULT_RETRY.max,
    on: def.retry?.on ?? DEFAULT_RETRY.on,
    backoff: def.retry?.backoff ?? DEFAULT_RETRY.backoff,
  };
  const retryTimeoutMs = def.retry?.timeoutMs ?? DEFAULT_RETRY.timeoutMs;
  if (retryTimeoutMs !== undefined) {
    (resolvedRetry as { timeoutMs?: number }).timeoutMs = retryTimeoutMs;
  }

  // Resolve mcp: new mcp field wins; legacy mcps is a deprecated alias.
  let resolvedMcp: AgentMcpConfig | undefined = def.mcp;
  if (
    resolvedMcp === undefined &&
    def.mcps !== undefined &&
    def.mcps.length > 0
  ) {
    console.warn(
      `[agentflow] runner="${def.runner}": the \`mcps\` field is deprecated — migrate to \`mcp: { servers: [...] }\`. See docs/superpowers/specs/2026-04-16-agents-use-mcp-design.md`,
    );
    resolvedMcp = {
      servers: def.mcps.map(migrateLegacyMcpEntry),
    };
  }

  const resolved: ResolvedAgentDef<I, O, R> = {
    ...def,
    sanitizeInput: def.sanitizeInput ?? true,
    retry: resolvedRetry,
    timeoutMs: def.timeoutMs ?? 300_000,
    maxOutputBytes: def.maxOutputBytes ?? 1_048_576,
  };
  if (resolvedMcp !== undefined) {
    // exactOptionalPropertyTypes: only set when defined
    (resolved as { mcp?: AgentMcpConfig }).mcp = resolvedMcp;
  }
  return resolved;
}

/**
 * Define a workflow from a map of tasks.
 *
 * @example
 * export default defineWorkflow({
 *   name: "bug-fix-pipeline",
 *   tasks: { analyze: { agent: analyzeAgent, input: { repoPath: "./src" } } },
 * });
 */
export function defineWorkflow<const T extends TasksMap>(
  config: WorkflowDef<T>,
): WorkflowDef<T> {
  return config;
}

/**
 * Define a workflow factory that closes over a typed input value.
 *
 * Captures the de-facto consumer pattern: wrap `defineWorkflow` in a function
 * that receives workflow-level data and threads it into task inputs via closure.
 * Removes per-pipeline boilerplate and the typing footgun of manually annotating
 * the factory return type.
 *
 * @example
 * // Before (manual factory):
 * export function createPipeline(input: PipelineInput): WorkflowDef<...> {
 *   return defineWorkflow({ name: "pipeline", tasks: { ... } });
 * }
 *
 * // After (using helper):
 * export const createPipeline = defineWorkflowFactory<PipelineInput>(
 *   (input) => ({ name: "pipeline", tasks: { ... } }),
 * );
 *
 * @remarks
 * v2: optional second argument for Zod input validation schema (deferred).
 * When added, the factory will parse+validate `input` before calling `fn`.
 */
export function defineWorkflowFactory<I, const T extends TasksMap = TasksMap>(
  fn: (input: I) => WorkflowDef<T>,
): (input: I) => WorkflowDef<T> {
  return (input: I) => defineWorkflow(fn(input));
}

/**
 * Define a loop task. Runs inner DAG iteratively until `until` returns true.
 *
 * @example
 * const fixLoop = loop({
 *   dependsOn: ["analyze"],
 *   max: 5,
 *   until: (ctx) => ctx.eval.output.satisfied === true,
 *   context: "persistent",
 *   input: (ctx) => ({ issues: ctx.analyze.output.issues }),
 *   tasks: { fix: fixTask, eval: evalTask },
 * });
 */
export function loop<const T extends TasksMap>(
  config: Omit<LoopDef<T>, "kind">,
): LoopDef<T> {
  return { ...config, kind: "loop" };
}

/**
 * Create a named session group for sharing conversation context between agents.
 * Session sharing works within a single provider only. Cross-provider sharing
 * is a TypeScript compile error.
 *
 * @example
 * const sharedCtx = sessionToken("analysis-context", "claude");
 * // Use in tasks:
 * analyze: { agent: analyzeAgent, session: sharedCtx }
 * summarize: { agent: summarizeAgent, session: sharedCtx }
 */
export function sessionToken<const R extends string>(
  name: string,
  runner: R,
): SessionToken<R> {
  validateStaticIdentifier(runner, "sessionToken runner");
  return { kind: "token", name } as SessionToken<R>;
}

/**
 * Create a transitive session reference to share context with another task's session.
 * The runner brand is inferred from the target task — passing this to an agent
 * with a different runner is a compile-time error.
 *
 * @example
 * summarize: { agent: summarizeAgent, session: shareSessionWith<typeof tasks, "analyze">("analyze") }
 */
export function shareSessionWith<
  T extends TasksMap,
  K extends keyof T & string,
>(_taskName: K): ShareSessionRef<RunnerOfTask<T, K>> {
  return { kind: "share", taskName: _taskName } as ShareSessionRef<
    RunnerOfTask<T, K>
  >;
}

/**
 * Register a runner implementation in the global registry.
 * Must be called before running any workflow that uses this runner.
 *
 * @example
 * import { ClaudeRunner } from "@ageflow/runner-claude";
 * registerRunner("claude", new ClaudeRunner());
 */
export function registerRunner(name: string, runner: Runner): void {
  validateStaticIdentifier(name, "runner name");
  _runnerRegistry.set(name, runner);
}

/**
 * Get a runner from the registry by name.
 * Used by the executor — not intended for user code.
 */
export function getRunner(name: string): Runner | undefined {
  return _runnerRegistry.get(name);
}

/**
 * Get all registered runners.
 */
export function getRunners(): ReadonlyMap<string, Runner> {
  return _runnerRegistry;
}

/**
 * Remove a runner from the registry by name.
 * Primarily for use in test harnesses to restore registry state.
 */
export function unregisterRunner(name: string): void {
  _runnerRegistry.delete(name);
}

/**
 * Shut down all registered runners that implement shutdown().
 * Process-level teardown — call from CLI exit handlers or server close().
 * Errors from individual runners are swallowed so one failure does not
 * prevent the others from cleaning up.
 */
export async function shutdownAllRunners(): Promise<void> {
  const runners = getRunners();
  const results = await Promise.allSettled(
    [...runners.values()].map(async (r) => r.shutdown?.()),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn("[agentflow] runner shutdown failed:", r.reason);
    }
  }
}
