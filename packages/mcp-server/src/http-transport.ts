/**
 * http-transport.ts
 *
 * Streamable HTTP transport for the AgentFlow MCP server.
 *
 * Uses the official `@modelcontextprotocol/sdk` StreamableHTTPServerTransport
 * rather than rolling a custom implementation. Wraps it in a plain Node.js
 * `node:http` server — no Express, no Fastify.
 *
 * Security defaults:
 * - Binds to 127.0.0.1 (loopback) by default.
 * - Non-loopback hosts require explicit `auth.type = "bearer"` — omitting auth
 *   on a non-loopback host throws at construction time so you can never
 *   accidentally expose workflows to the public internet.
 * - CORS is disabled by default; `cors.origin = "*"` emits a warning.
 * - This transport speaks plain HTTP — put it behind a TLS-terminating reverse
 *   proxy (nginx, Caddy) for production use.
 *
 * Usage:
 * ```ts
 * const httpServer = createHttpTransport(handle, {
 *   port: 3000,
 *   auth: { type: "bearer", token: process.env.MCP_TOKEN! },
 * }, "my-server", "1.0.0");
 * await httpServer.start();
 * ```
 */

import * as crypto from "node:crypto";
import * as http from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerHandle } from "./server.js";
import { startStdioTransport } from "./stdio-transport.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Bearer token auth or explicitly "none" (only permitted on loopback). */
export type HttpTransportAuth =
  | { readonly type: "bearer"; readonly token: string }
  | { readonly type: "none" };

/** CORS policy. Leave unset to disable CORS entirely. */
export interface HttpTransportCors {
  /**
   * Origin(s) to allow.
   *
   * - `"*"` allows all origins (emits a warning at startup).
   * - A specific origin string or array restricts cross-origin access.
   *
   * Security note: the configured value(s) are used directly in the response
   * header — the request's Origin header is never echoed back.
   */
  readonly origin: string | readonly string[] | "*";
}

/** Simple fixed-window in-memory rate limiter. */
export interface HttpTransportRateLimit {
  /** Duration of each counting window in milliseconds. */
  readonly windowMs: number;
  /** Maximum number of MCP POST requests per window per IP. */
  readonly max: number;
}

/** Shape of events delivered to the optional audit log callback. */
export interface AuditEvent {
  /** Unix timestamp (ms) when the tool call arrived. */
  readonly ts: number;
  /** Remote IP address (best-effort — may be "unknown"). */
  readonly remoteIp: string;
  /** Tool name extracted from the JSON-RPC body (tools/call only). */
  readonly toolName: string | undefined;
  /** Raw JSON-RPC method (e.g. "tools/call", "initialize"). */
  readonly method: string | undefined;
  /** `true` if the request was rejected by auth. */
  readonly authDenied: boolean;
  /** `true` if the request was rejected by rate-limiting. */
  readonly rateLimited: boolean;
}

/** Options passed to `createHttpTransport()`. */
export interface HttpTransportOptions {
  /** TCP port to listen on. */
  readonly port: number;
  /**
   * Host to bind. Default: `"127.0.0.1"` (loopback only).
   *
   * To expose the server on all interfaces use `"0.0.0.0"`, but `auth` MUST
   * be `{ type: "bearer", token: "..." }` — omitting auth on a non-loopback
   * host throws at construction time.
   */
  readonly host?: string;
  /**
   * URL path that handles MCP requests. Default: `"/mcp"`.
   */
  readonly path?: string;
  /**
   * Authentication policy. Default: `{ type: "none" }`.
   *
   * Restriction: `{ type: "none" }` is only permitted when `host` resolves to
   * a loopback address (`127.0.0.1` or `::1`). Any other host requires
   * bearer auth.
   */
  readonly auth?: HttpTransportAuth;
  /**
   * CORS configuration. Default: CORS disabled.
   *
   * Only applies to browser-originated requests. MCP CLI clients don't need
   * CORS — enable only when you have a browser-based MCP client.
   */
  readonly cors?: HttpTransportCors;
  /**
   * Simple in-memory rate limiter.  Counts POST requests per remote IP within
   * a fixed window.
   */
  readonly rateLimit?: HttpTransportRateLimit;
  /**
   * Optional callback invoked for every MCP request.
   * Useful for security auditing, telemetry, or debugging.
   */
  readonly auditLog?: (event: AuditEvent) => void;
  /**
   * Optional stderr writer (for startup messages + warnings).
   * Defaults to `process.stderr.write`.
   */
  readonly stderr?: (line: string) => void;
  /**
   * Whether to trust the `X-Forwarded-For` header when determining the client
   * IP address for rate limiting and audit logging.
   *
   * **Default: `false` (secure default).**
   *
   * Set to `true` ONLY when the server runs behind a reverse proxy you
   * control (nginx, Caddy, etc.) that sets `X-Forwarded-For` to the real
   * client IP. Direct internet exposure MUST leave this `false` — otherwise
   * any client can spoof their IP, bypassing rate limits and forging audit
   * log entries.
   */
  readonly trustProxy?: boolean;
  /**
   * Maximum size of the request body in bytes.
   *
   * Default: `1_048_576` (1 MiB). Requests exceeding this limit are rejected
   * with `413 Payload Too Large` before any parsing — preventing OOM DoS via
   * unbounded `Buffer.concat`.
   */
  readonly maxBodyBytes?: number;
  /**
   * Maximum number of concurrent MCP sessions.
   *
   * Default: `1000`. When exceeded, new `initialize` requests are rejected
   * with `429 Too Many Sessions` without creating a new session or transport
   * pair. Existing sessions continue unaffected.
   */
  readonly maxSessions?: number;
}

/** Handle returned by `createHttpTransport()`. */
export interface HttpTransportHandle {
  /**
   * Start the HTTP server and begin accepting connections.
   * Resolves once the port is bound.
   */
  start(): Promise<void>;
  /**
   * Stop the HTTP server and close all active connections.
   * Safe to call multiple times.
   */
  stop(): Promise<void>;
  /**
   * Returns the bound address.  Only valid after `start()` resolves.
   */
  address(): { readonly port: number; readonly host: string };
  /**
   * Live count of active MCP sessions (for tests / monitoring).
   * @internal
   */
  readonly sessionCount: number;
  /**
   * Exposes the rate-limiter's current tracked IP count.
   * Only set when `rateLimit` is configured. For testing only.
   * @internal
   */
  readonly _rateLimiterSize: number | undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function remoteIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      return forwarded.split(",")[0]?.trim() ?? "unknown";
    }
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Hard cap on tracked IP entries to prevent unbounded memory growth. */
const RATE_LIMITER_MAX_ENTRIES = 10_000;

/** Simple fixed-window rate limiter (in-memory, per-IP). */
class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly windows = new Map<
    string,
    { count: number; windowStart: number }
  >();

  constructor(opts: HttpTransportRateLimit) {
    this.windowMs = opts.windowMs;
    this.max = opts.max;
  }

  /** Returns `true` if the request should be allowed, `false` if rate-limited. */
  check(ip: string): boolean {
    const now = Date.now();

    // Lazy prune: evict all entries whose window expired more than 2× ago.
    // This runs on every check so no background timer is needed (and no leak).
    const cutoff = now - this.windowMs * 2;
    for (const [key, entry] of this.windows) {
      if (entry.windowStart < cutoff) {
        this.windows.delete(key);
      }
    }

    // Hard cap: if the map is still over the limit after pruning, evict the
    // oldest entries (insertion order) until we're back under the cap.
    if (this.windows.size >= RATE_LIMITER_MAX_ENTRIES) {
      const toEvict = this.windows.size - RATE_LIMITER_MAX_ENTRIES + 1;
      let evicted = 0;
      for (const key of this.windows.keys()) {
        this.windows.delete(key);
        evicted++;
        if (evicted >= toEvict) break;
      }
    }

    const entry = this.windows.get(ip);
    if (entry === undefined || now - entry.windowStart >= this.windowMs) {
      this.windows.set(ip, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= this.max) {
      return false;
    }
    entry.count++;
    return true;
  }

  /** Expose map size for testing. @internal */
  get size(): number {
    return this.windows.size;
  }
}

/**
 * Read the full request body and JSON-parse it.
 *
 * Returns `{ ok: true, body }` on success, `{ ok: false, tooLarge: true }` if
 * the body exceeds `maxBytes`, or `{ ok: false, tooLarge: false }` on any
 * other error.
 */
async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        aborted = true;
        // Drain the socket so the client gets the response.
        req.resume();
        resolve({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: true,
          body: raw.length > 0 ? JSON.parse(raw) : undefined,
        });
      } catch {
        resolve({ ok: false, tooLarge: false });
      }
    });

    req.on("error", () => {
      if (!aborted) resolve({ ok: false, tooLarge: false });
    });
  });
}

function extractRpcMethod(body: unknown): string | undefined {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const m = (body as Record<string, unknown>).method;
    return typeof m === "string" ? m : undefined;
  }
  return undefined;
}

function extractToolName(body: unknown): string | undefined {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const params = (body as Record<string, unknown>).params;
    if (
      params !== null &&
      typeof params === "object" &&
      !Array.isArray(params)
    ) {
      const name = (params as Record<string, unknown>).name;
      return typeof name === "string" ? name : undefined;
    }
  }
  return undefined;
}

// ─── Session record ───────────────────────────────────────────────────────────

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  sdkServer: Server;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an HTTP transport that serves the given MCP handle over Streamable HTTP.
 *
 * Each new MCP initialize request spawns a fresh `StreamableHTTPServerTransport`
 * + SDK Server pair.  Subsequent requests in the same session (identified by
 * `Mcp-Session-Id`) reuse the existing pair.
 *
 * @param handle        - The `McpServerHandle` to expose (from `createMcpServer()`).
 * @param opts          - Transport configuration.
 * @param serverName    - Advertised MCP server name.
 * @param serverVersion - Advertised MCP server version.
 */
export function createHttpTransport(
  handle: McpServerHandle,
  opts: HttpTransportOptions,
  serverName: string,
  serverVersion: string,
): HttpTransportHandle {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port;
  const mcpPath = opts.path ?? "/mcp";
  const auth = opts.auth ?? { type: "none" };
  const cors = opts.cors;
  const rateLimitOpts = opts.rateLimit;
  const auditLog = opts.auditLog;
  const trustProxy = opts.trustProxy ?? false;
  const maxBodyBytes = opts.maxBodyBytes ?? 1_048_576;
  const maxSessions = opts.maxSessions ?? 1_000;
  const writeStderr =
    opts.stderr ??
    ((line: string) => {
      process.stderr.write(line);
    });

  // ── Security precondition: non-loopback requires bearer auth ─────────────────
  if (!isLoopback(host) && auth.type !== "bearer") {
    throw new Error(
      `[ageflow mcp] HTTP transport on non-loopback host "${host}" requires auth: { type: "bearer", token: "..." }. This prevents accidentally exposing workflows to the public internet.`,
    );
  }

  // ── CORS warning ──────────────────────────────────────────────────────────────
  if (cors?.origin === "*") {
    writeStderr(
      '[ageflow mcp] WARNING: cors.origin = "*" allows requests from any ' +
        "browser origin. This is discouraged in production.\n",
    );
  }

  // ── Rate limiter ──────────────────────────────────────────────────────────────
  const rateLimiter =
    rateLimitOpts !== undefined ? new RateLimiter(rateLimitOpts) : undefined;

  // ── Active sessions ───────────────────────────────────────────────────────────
  const sessions = new Map<string, SessionRecord>();

  // ── Node.js HTTP server ───────────────────────────────────────────────────────
  let nodeServer: http.Server | undefined;
  let boundAddress: { port: number; host: string } | undefined;

  // ── CORS helper ───────────────────────────────────────────────────────────────
  /**
   * Add CORS response headers when CORS is configured and the request's Origin
   * matches the configured allowlist.
   *
   * Security: we NEVER echo the request's Origin header back — that would
   * allow any origin regardless of configuration.  Instead we validate the
   * request origin against the configured allowlist and write the matching
   * *configured* value (a static string we control).
   */
  function applyCors(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (cors === undefined) return;

    const requestOrigin = req.headers.origin;
    if (requestOrigin === undefined) return;

    // For "*" the static literal "*" is the allow value — never user-derived.
    // For specific origins we look up the configured string that matches the
    // request, then write that configured string (not the request header).
    let allowValue: string | undefined;
    if (cors.origin === "*") {
      allowValue = "*";
    } else if (typeof cors.origin === "string") {
      // Single configured origin: use the configured value if it matches.
      allowValue = requestOrigin === cors.origin ? cors.origin : undefined;
    } else {
      // Array of configured origins: find the matching configured entry.
      const origins = cors.origin as readonly string[];
      allowValue = origins.find((o) => o === requestOrigin);
    }

    if (allowValue !== undefined) {
      res.setHeader("Access-Control-Allow-Origin", allowValue);
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Mcp-Session-Id, Accept",
      );
      res.setHeader("Access-Control-Max-Age", "86400");
      if (allowValue !== "*") {
        res.setHeader("Vary", "Origin");
      }
    }
  }

  // ── Auth helper ───────────────────────────────────────────────────────────────
  function checkAuth(req: http.IncomingMessage): boolean {
    if (auth.type === "none") return true;
    const headerVal = req.headers.authorization;
    if (typeof headerVal !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(headerVal);
    if (match === null) return false;
    // Constant-time comparison prevents timing attacks.
    const provided = match[1] ?? "";
    const expected = auth.token;
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(provided, "utf8"),
      Buffer.from(expected, "utf8"),
    );
  }

  // ── Session factory ───────────────────────────────────────────────────────────
  async function createSession(): Promise<SessionRecord> {
    const sessionId = crypto.randomUUID();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (sid) => {
        // Re-key the session record with the confirmed session ID.
        const record = sessions.get(sid);
        if (record === undefined) {
          // Store it — happens when onsessioninitialized fires during handleRequest.
          sessions.set(sid, { transport, sdkServer });
        }
      },
      onsessionclosed: (sid) => {
        const record = sessions.get(sid);
        if (record !== undefined) {
          sessions.delete(sid);
          void record.sdkServer.close().catch(() => {});
        }
      },
    });

    // Start the SDK server on top of this transport.  startStdioTransport
    // wires tools/list and tools/call handlers then calls server.connect().
    // Cast required: StreamableHTTPServerTransport implements Transport but
    // exactOptionalPropertyTypes makes onclose setter incompatible at type level.
    const sdkServer = await startStdioTransport({
      serverName,
      serverVersion,
      handle,
      transport: transport as Transport,
      stderr: writeStderr,
    });

    // Pre-register so onsessioninitialized can find the record.
    sessions.set(sessionId, { transport, sdkServer });

    const record: SessionRecord = { transport, sdkServer };
    return record;
  }

  // ── Main request handler ──────────────────────────────────────────────────────
  async function requestHandler(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const ip = remoteIp(req, trustProxy);
    const method = req.method?.toUpperCase() ?? "";
    const url = req.url ?? "/";

    // CORS preflight (OPTIONS) — must be handled before auth to allow browsers
    // to discover allowed origins before sending credentials.
    if (method === "OPTIONS") {
      applyCors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Only handle the configured MCP path.
    const pathname = url.split("?")[0] ?? "/";
    if (pathname !== mcpPath) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    // Auth check.
    if (!checkAuth(req)) {
      auditLog?.({
        ts: Date.now(),
        remoteIp: ip,
        toolName: undefined,
        method: undefined,
        authDenied: true,
        rateLimited: false,
      });
      applyCors(req, res);
      res.setHeader("WWW-Authenticate", 'Bearer realm="ageflow-mcp"');
      jsonResponse(res, 401, { error: "Unauthorized" });
      return;
    }

    // Rate limit — applied to POST only (GET/DELETE are control-plane requests).
    if (method === "POST" && rateLimiter !== undefined) {
      if (!rateLimiter.check(ip)) {
        auditLog?.({
          ts: Date.now(),
          remoteIp: ip,
          toolName: undefined,
          method: undefined,
          authDenied: false,
          rateLimited: true,
        });
        applyCors(req, res);
        jsonResponse(res, 429, { error: "Too Many Requests" });
        return;
      }
    }

    // Parse request body for POST requests (needed by handleRequest + audit log).
    let parsedBody: unknown;
    if (method === "POST") {
      const bodyResult = await readJsonBody(req, maxBodyBytes);
      if (!bodyResult.ok) {
        if (bodyResult.tooLarge) {
          applyCors(req, res);
          jsonResponse(res, 413, { error: "Payload Too Large" });
          return;
        }
        // Parse error — let the SDK handle downstream with undefined body.
        parsedBody = undefined;
      } else {
        parsedBody = bodyResult.body;
      }
    }

    // Audit log for legitimate POST requests.
    if (auditLog !== undefined && method === "POST") {
      auditLog({
        ts: Date.now(),
        remoteIp: ip,
        toolName: extractToolName(parsedBody),
        method: extractRpcMethod(parsedBody),
        authDenied: false,
        rateLimited: false,
      });
    }

    // Route to the correct session.
    const rawSessionId = req.headers["mcp-session-id"];
    const sessionKey =
      typeof rawSessionId === "string" ? rawSessionId : undefined;

    let record: SessionRecord | undefined;

    if (sessionKey !== undefined) {
      // Existing session lookup.
      record = sessions.get(sessionKey);
      if (record === undefined) {
        applyCors(req, res);
        jsonResponse(res, 404, { error: "Session not found" });
        return;
      }
    } else if (method === "POST") {
      // No session ID on a POST = new session (initialize request).
      // Enforce session cap before allocating new resources.
      if (sessions.size >= maxSessions) {
        auditLog?.({
          ts: Date.now(),
          remoteIp: ip,
          toolName: undefined,
          method: extractRpcMethod(parsedBody),
          authDenied: false,
          rateLimited: false,
        });
        applyCors(req, res);
        jsonResponse(res, 429, { error: "Too Many Sessions" });
        return;
      }
      record = await createSession();
    } else {
      // GET or DELETE without session ID is invalid.
      applyCors(req, res);
      jsonResponse(res, 400, { error: "Missing Mcp-Session-Id header" });
      return;
    }

    // Delegate to the SDK transport.
    applyCors(req, res);
    await record.transport.handleRequest(req, res, parsedBody);
  }

  // ── Public handle ─────────────────────────────────────────────────────────────
  return {
    get sessionCount(): number {
      return sessions.size;
    },

    get _rateLimiterSize(): number | undefined {
      return rateLimiter?.size;
    },

    async start(): Promise<void> {
      if (nodeServer !== undefined) {
        throw new Error("[ageflow mcp] HTTP transport already started");
      }

      nodeServer = http.createServer((req, res) => {
        requestHandler(req, res).catch((err: unknown) => {
          writeStderr(
            `[ageflow mcp] unhandled error in HTTP handler: ${String(err)}\n`,
          );
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end();
        });
      });

      await new Promise<void>((resolve, reject) => {
        nodeServer?.listen(port, host, () => {
          const addr = nodeServer?.address();
          const actualPort =
            addr !== null && typeof addr === "object" ? addr.port : port;
          boundAddress = { port: actualPort, host };
          writeStderr(
            `[ageflow mcp] ${serverName}@${serverVersion} HTTP transport listening on ` +
              `http://${host}:${actualPort}${mcpPath}\n`,
          );
          if (auth.type === "none") {
            writeStderr(
              "[ageflow mcp] WARNING: running without authentication — suitable for loopback only.\n",
            );
          }
          resolve();
        });
        nodeServer?.once("error", reject);
      });
    },

    async stop(): Promise<void> {
      // Close all active SDK servers (which will close their transports).
      const closures = [...sessions.values()].map((rec) =>
        rec.sdkServer.close().catch(() => {}),
      );
      await Promise.all(closures);
      sessions.clear();

      if (nodeServer !== undefined) {
        await new Promise<void>((resolve, reject) => {
          nodeServer?.close((err) => {
            if (err !== undefined) reject(err);
            else resolve();
          });
        });
        nodeServer = undefined;
      }
    },

    address(): { port: number; host: string } {
      if (boundAddress === undefined) {
        throw new Error(
          "[ageflow mcp] HTTP transport not started — call start() first",
        );
      }
      return boundAddress;
    },
  };
}
