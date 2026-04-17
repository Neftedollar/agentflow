// ─── Programmatic API (primary public surface) ────────────────────────────────
export { createMcpServer } from "./programmatic.js";
export type {
  McpServerConfig,
  McpHandle,
  McpMiddleware,
  McpMiddlewareRequest,
  McpHitlHandler,
  McpTransportConfig,
  McpHttpTransportConfig,
} from "./programmatic.js";

// ─── HTTP transport (advanced / programmatic use) ────────────────────────────
export { createHttpTransport } from "./http-transport.js";
export type {
  HttpTransportOptions,
  HttpTransportHandle,
  HttpTransportAuth,
  HttpTransportCors,
  HttpTransportRateLimit,
  AuditEvent,
} from "./http-transport.js";

// ─── Internal single-workflow server (CLI + advanced use) ────────────────────
export { createSingleWorkflowServer } from "./server.js";
export type {
  McpServerOptions,
  McpServerHandle,
  McpToolResult,
  RunWorkflowFn,
} from "./server.js";
export { startStdioTransport } from "./stdio-transport.js";
export type { StdioTransportOptions } from "./stdio-transport.js";
export type { CliCeilings, EffectiveCeilings, HitlStrategy } from "./types.js";
export { ErrorCode, McpServerError } from "./errors.js";
export { buildJobTools } from "./job-tools.js";
