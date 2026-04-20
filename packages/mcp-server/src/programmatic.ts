/**
 * programmatic.ts
 *
 * Public programmatic API for embedding the AgentFlow MCP server in custom
 * Node.js processes. Exposes `createMcpServer({ workflows, middleware?, onHitl? })`
 * which returns an `McpHandle` with `listen()` and `close()`.
 *
 * Design:
 * - Each workflow gets its own internal McpServerHandle (from server.ts).
 * - A thin router delegates listTools / callTool by tool name prefix.
 * - Middleware wraps callTool — each middleware gets (request, next).
 * - onHitl wires into the workflow's hooks.onCheckpoint.
 * - transport defaults to stdio; HTTP transport is tracked in #21.
 */

import type { WorkflowDef } from "@ageflow/core";
import type { RunStore } from "@ageflow/server";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type HttpTransportHandle,
  type HttpTransportOptions,
  createHttpTransport,
} from "./http-transport.js";
import {
  type McpServerHandle,
  type McpToolResult,
  createSingleWorkflowServer,
} from "./server.js";
import { startStdioTransport } from "./stdio-transport.js";
import type { CliCeilings, HitlStrategy } from "./types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A middleware function in the MCP request pipeline.
 *
 * Receives the tool name + arguments, and a `next` function to invoke the
 * actual handler. Can short-circuit by returning an error result directly
 * without calling `next`.
 *
 * Note: middleware cannot modify tool responses in this version — return value
 * from `next()` is returned as-is. Full response transformation is deferred.
 *
 * @example
 * const authMiddleware: McpMiddleware = async (req, next) => {
 *   if (!req.args.apiKey) {
 *     return { content: [{ type: "text", text: "Unauthorized" }], isError: true };
 *   }
 *   return next();
 * };
 */
export type McpMiddleware = (
  request: McpMiddlewareRequest,
  next: () => Promise<McpToolResult>,
) => Promise<McpToolResult>;

export interface McpMiddlewareRequest {
  /** The name of the tool being called. */
  readonly toolName: string;
  /** The raw arguments passed to the tool. */
  readonly args: unknown;
}

/**
 * Custom HITL handler for programmatic embedding.
 *
 * Called when a workflow reaches a HITL checkpoint. Return `true` to approve,
 * `false` to reject. Throwing will propagate as a workflow error.
 *
 * Note: in this version, `onHitl` is called in place of elicitation. When the
 * MCP transport's native elicitation is preferred, set `hitlStrategy: "elicit"`
 * and omit `onHitl`.
 */
export type McpHitlHandler = (
  taskName: string,
  message: string,
) => Promise<boolean>;

/**
 * HTTP transport configuration object for `McpTransportConfig`.
 *
 * When `type` is `"http"`, `createMcpServer()` starts a Node.js HTTP server
 * backed by `StreamableHTTPServerTransport` from the MCP SDK.
 *
 * Security defaults:
 * - `host` defaults to `"127.0.0.1"` (loopback). Non-loopback hosts require
 *   `auth: { type: "bearer", token: "..." }`.
 * - CORS is disabled by default.
 * - This transport speaks plain HTTP — use a reverse proxy for TLS.
 *
 * @example
 * ```ts
 * createMcpServer({
 *   workflows: [myWorkflow],
 *   transport: {
 *     type: "http",
 *     port: 3000,
 *     auth: { type: "bearer", token: process.env.MCP_TOKEN! },
 *   },
 * });
 * ```
 */
export interface McpHttpTransportConfig extends HttpTransportOptions {
  readonly type: "http";
}

/**
 * Transport configuration for the MCP server.
 *
 * - `"stdio"` (default): connect to process stdin/stdout.
 * - `{ type: "http", port, ... }`: Streamable HTTP transport (#21).
 * - You may pass a raw `Transport` instance (e.g. InMemoryTransport for tests).
 */
export type McpTransportConfig = "stdio" | McpHttpTransportConfig | Transport;

/**
 * Configuration for `createMcpServer()`.
 */
export interface McpServerConfig {
  /**
   * One or more workflow definitions to expose as MCP tools.
   *
   * Each workflow must have a unique `name` — tool names are derived directly
   * from workflow names. Duplicate names will throw at construction time.
   *
   * Accepts both single-workflow and multi-workflow:
   *   `{ workflow: myWorkflow }` or `{ workflows: [wf1, wf2] }`
   */
  workflows: WorkflowDef | WorkflowDef[];

  /**
   * Middleware chain executed for every `callTool` request.
   * Applied in array order: first middleware in = outermost wrapper.
   */
  middleware?: McpMiddleware[];

  /**
   * Custom HITL handler. When set, overrides the default `hitlStrategy`
   * for all workflows — returning true/false approves/rejects the checkpoint.
   *
   * When absent, `hitlStrategy` applies (default: "elicit").
   */
  onHitl?: McpHitlHandler;

  /**
   * Default HITL strategy when `onHitl` is not set. Default: "elicit".
   * Has no effect if `onHitl` is provided.
   */
  hitlStrategy?: HitlStrategy;

  /**
   * Per-workflow ceiling overrides (maxCostUsd, maxDurationSec, maxTurns).
   * Applied to all workflows. Default: no overrides (workflow config applies).
   */
  ceilings?: CliCeilings;

  /**
   * Optional async job snapshot store shared across workflow handles.
   * When omitted, each workflow handle gets its own in-memory store.
   */
  jobStore?: RunStore;

  /**
   * MCP server name advertised during initialization. Defaults to the first
   * workflow's name (or "ageflow-mcp" for multi-workflow setups).
   */
  serverName?: string;

  /**
   * MCP server version advertised during initialization. Default: "0.1.0".
   */
  serverVersion?: string;

  /**
   * Transport to use. Default: `"stdio"`.
   *
   * - `"stdio"` — connects to `process.stdin`/`stdout` (default).
   * - `{ type: "http", port, host?, path?, auth?, cors?, rateLimit?, auditLog? }` —
   *   Streamable HTTP transport. Bind is loopback-only by default; non-loopback
   *   requires `auth: { type: "bearer", token }`.
   * - Raw `Transport` instance — useful for tests (`InMemoryTransport`).
   */
  transport?: McpTransportConfig;

  /**
   * Custom stderr writer. Defaults to process.stderr.write.
   */
  stderr?: (line: string) => void;
}

/**
 * Server handle returned by `createMcpServer()`.
 */
export interface McpHandle {
  /**
   * Start listening on the configured transport.
   *
   * For stdio (default), this connects to process.stdin/stdout.
   * For HTTP transport, this binds the TCP port.
   * Returns a promise that resolves when the transport is ready.
   */
  listen(): Promise<void>;

  /**
   * Stop the server and release resources.
   */
  close(): Promise<void>;

  /**
   * When the server is configured with `transport: { type: "http", ... }`,
   * this is the HTTP transport handle (exposes `.address()`, `.sessionCount`).
   * `undefined` for stdio / raw Transport.
   */
  readonly httpHandle: HttpTransportHandle | undefined;

  /**
   * The underlying multi-workflow router handle (pre-middleware).
   * Setting `_testRunExecutor` here propagates to all per-workflow handles.
   * Use this for executor injection in tests.
   */
  readonly _routerHandle: McpServerHandle;

  /**
   * The middleware-wrapped handle used by the transport.
   * Use this in tests that need to verify middleware execution.
   * Identical to `_routerHandle` when no middleware is configured.
   */
  readonly _finalHandle: McpServerHandle;
}

// ─── Internal router ──────────────────────────────────────────────────────────

/**
 * Build a single McpServerHandle that routes to multiple per-workflow handles.
 *
 * `_testRunExecutor` is propagated to all inner handles when set, so tests can
 * inject a mock executor via the router without needing access to inner handles.
 */
function buildMultiRouter(
  perWorkflowHandles: Map<string, McpServerHandle>,
): McpServerHandle {
  const handles = [...perWorkflowHandles.values()];

  const router: McpServerHandle = {
    async listTools() {
      const all = await Promise.all(handles.map((h) => h.listTools()));
      return all.flat();
    },

    async callTool(name, args, opts) {
      // Find the handle whose toolset contains this tool name.
      for (const handle of handles) {
        const tools = await handle.listTools();
        if (tools.some((t) => t.name === name)) {
          return handle.callTool(name, args, opts);
        }
      }
      // Unknown tool
      const { formatErrorResult } = await import("./errors.js");
      const { ErrorCode, McpServerError } = await import("./errors.js");
      return formatErrorResult(
        new McpServerError(ErrorCode.WORKFLOW_FAILED, `unknown tool: ${name}`, {
          name,
        }),
      );
    },

    dispose() {
      for (const handle of handles) {
        handle.dispose?.();
      }
    },
  };

  // Propagate _testRunExecutor to all inner handles when set on the router.
  // This lets tests inject a mock executor via handle._routerHandle._testRunExecutor
  // without needing direct access to individual per-workflow handles.
  Object.defineProperty(router, "_testRunExecutor", {
    get(): McpServerHandle["_testRunExecutor"] {
      return handles[0]?._testRunExecutor;
    },
    set(fn: McpServerHandle["_testRunExecutor"]) {
      for (const h of handles) {
        if (fn !== undefined) {
          h._testRunExecutor = fn;
        } else {
          // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes prevents undefined assignment
          delete h._testRunExecutor;
        }
      }
    },
    enumerable: true,
    configurable: true,
  });

  return router;
}

/**
 * Wrap a handle with a middleware chain.
 * Middleware is applied in array order (first = outermost).
 */
function applyMiddleware(
  inner: McpServerHandle,
  middleware: McpMiddleware[],
): McpServerHandle {
  if (middleware.length === 0) return inner;

  return {
    ...inner,
    async callTool(name, args, opts) {
      const req: McpMiddlewareRequest = { toolName: name, args };

      // Build a chain from the inside out
      const chain = [...middleware]
        .reverse()
        .reduce<() => Promise<McpToolResult>>(
          (next, mw) => () => mw(req, next),
          () => inner.callTool(name, args, opts),
        );

      return chain();
    },
  };
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Create a programmatic MCP server that can be embedded in any Node.js process.
 *
 * @example
 * ```ts
 * import { createMcpServer } from "@ageflow/mcp-server";
 * import devPipeline from "./workflows/dev.ts";
 * import deployWorkflow from "./workflows/deploy.ts";
 *
 * const server = createMcpServer({
 *   workflows: [devPipeline, deployWorkflow],
 *   middleware: [authMiddleware, rateLimitMiddleware],
 *   onHitl: async (taskName, prompt) => {
 *     return await askUser(prompt); // returns true/false
 *   },
 * });
 *
 * await server.listen();
 * ```
 *
 * ## Multi-workflow
 * All workflows are exposed as separate tools. Tool names are derived from
 * workflow names (`workflow.name`). Names must be unique across workflows.
 *
 * ## Middleware
 * Middleware wraps every `callTool` invocation. Use it for auth, rate limiting,
 * logging, etc. Each middleware receives `{ toolName, args }` and a `next()`
 * function. Returning without calling `next()` short-circuits the call.
 *
 * ## HITL
 * When `onHitl` is provided it overrides the default elicitation strategy.
 * Return `true` from `onHitl` to approve, `false` to reject.
 *
 * ## Transport
 * Defaults to stdio. For remote / team deployment use HTTP transport:
 * ```ts
 * createMcpServer({
 *   workflows: [myWorkflow],
 *   transport: {
 *     type: "http",
 *     port: 3000,
 *     auth: { type: "bearer", token: process.env.MCP_TOKEN! },
 *   },
 * });
 * ```
 * Pass a raw `Transport` instance (e.g. `InMemoryTransport`) for testing.
 *
 * ## CLI
 * The CLI `agentwf mcp serve workflow.ts` continues to work unchanged.
 * It uses the internal single-workflow API from `server.ts` directly.
 */
export function createMcpServer(config: McpServerConfig): McpHandle {
  // Normalise workflows to array
  const workflowList = Array.isArray(config.workflows)
    ? config.workflows
    : [config.workflows];

  if (workflowList.length === 0) {
    throw new Error("createMcpServer: at least one workflow must be provided");
  }

  // Check for duplicate workflow names (= tool name collisions)
  const names = workflowList.map((w) => w.name);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(
        `createMcpServer: duplicate workflow name "${name}" — tool names must be unique`,
      );
    }
    seen.add(name);
  }

  const hitlStrategy = config.hitlStrategy ?? "elicit";
  const stderr =
    config.stderr ??
    ((line: string) => {
      process.stderr.write(line);
    });

  // Build per-workflow internal handles.
  // When onHitl is provided, inject it as a workflow-level onCheckpoint hook.
  const perWorkflowHandles = new Map<string, McpServerHandle>();
  for (const workflow of workflowList) {
    // If onHitl is set, wrap the workflow's hooks to wire the callback.
    let patchedWorkflow = workflow;
    if (config.onHitl !== undefined) {
      const onHitl = config.onHitl;
      const existingHooks = workflow.hooks;
      const existingOnCheckpoint = existingHooks?.onCheckpoint;

      patchedWorkflow = {
        ...workflow,
        hooks: {
          ...(existingHooks ?? {}),
          onCheckpoint: async (taskName: string, message: string) => {
            // Call existing hook first (if any); if it returns true, approve
            if (existingOnCheckpoint !== undefined) {
              const existing = await Promise.resolve(
                (existingOnCheckpoint as (t: string, m: string) => unknown)(
                  taskName,
                  message,
                ),
              );
              if (existing === true) return true as unknown as undefined;
            }
            // Delegate to programmatic onHitl
            const approved = await onHitl(taskName, message);
            return approved as unknown as undefined;
          },
        },
      };
    }

    const handle = createSingleWorkflowServer({
      workflow: patchedWorkflow,
      cliCeilings: config.ceilings ?? {},
      ...(config.jobStore !== undefined ? { jobStore: config.jobStore } : {}),
      // When onHitl is set it is baked into patchedWorkflow.hooks.onCheckpoint.
      // buildMcpHooks in hitl-bridge.ts calls that hook first: if it returns true
      // the checkpoint is approved; if it returns false the bridge falls through
      // to the hitlStrategy. Using "fail" here ensures that a false return from
      // onHitl is honoured as a rejection rather than silently auto-approved.
      // When onHitl is NOT set, fall back to the caller-supplied hitlStrategy
      // (default: "elicit").
      hitlStrategy: config.onHitl !== undefined ? "fail" : hitlStrategy,
      stderr,
    });

    perWorkflowHandles.set(workflow.name, handle);
  }

  // Build multi-workflow router
  const router = buildMultiRouter(perWorkflowHandles);

  // Apply middleware
  const finalHandle = applyMiddleware(router, config.middleware ?? []);

  // Determine server name
  const serverName =
    config.serverName ??
    (workflowList.length === 1
      ? (workflowList[0]?.name ?? "ageflow-mcp")
      : "ageflow-mcp");

  const serverVersion = config.serverVersion ?? "0.1.0";

  // SDK Server instance (for stdio / raw Transport path — lazily set on listen)
  let sdkServer:
    | import("@modelcontextprotocol/sdk/server/index.js").Server
    | undefined;

  // HTTP transport handle (for the { type: "http", ... } path)
  let httpHandle: HttpTransportHandle | undefined;

  const handle: McpHandle = {
    // Expose the raw router (pre-middleware) so tests can inject _testRunExecutor
    // and it propagates to all per-workflow handles.
    _routerHandle: router,

    // Expose the middleware-wrapped handle for middleware verification in tests.
    _finalHandle: finalHandle,

    get httpHandle(): HttpTransportHandle | undefined {
      return httpHandle;
    },

    async listen() {
      const transportConfig = config.transport;

      if (
        transportConfig !== undefined &&
        typeof transportConfig === "object" &&
        "type" in transportConfig &&
        transportConfig.type === "http"
      ) {
        // HTTP transport path
        const httpConfig = transportConfig as McpHttpTransportConfig;
        const { type: _type, ...httpOpts } = httpConfig;
        httpHandle = createHttpTransport(
          finalHandle,
          httpOpts,
          serverName,
          serverVersion,
        );
        await httpHandle.start();
      } else {
        // stdio / raw Transport path
        const transportArg: Transport | undefined =
          transportConfig === undefined || transportConfig === "stdio"
            ? undefined
            : (transportConfig as Transport);

        sdkServer = await startStdioTransport({
          serverName,
          serverVersion,
          handle: finalHandle,
          stderr,
          ...(transportArg !== undefined ? { transport: transportArg } : {}),
        });
      }
    },

    async close() {
      // Dispose per-workflow handles (stop background reapers etc.)
      finalHandle.dispose?.();

      if (httpHandle !== undefined) {
        try {
          await httpHandle.stop();
        } catch {
          // ignore close errors during shutdown
        }
        httpHandle = undefined;
      }

      if (sdkServer !== undefined) {
        try {
          await sdkServer.close();
        } catch {
          // ignore close errors during shutdown
        }
        sdkServer = undefined;
      }
    },
  };

  return handle;
}
