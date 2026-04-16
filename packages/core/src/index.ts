// v1 API surface — stable
// All exports below are part of the public API

// Types
export type {
  AgentDef,
  AgentMcpConfig,
  BoundCtx,
  ResolvedAgentDef,
  BudgetConfig,
  BudgetWarningEvent,
  CheckpointEvent,
  CtxFor,
  DependsOnOf,
  HITLConfig,
  HITLMode,
  InputOf,
  Logger,
  LoopContext,
  LoopDef,
  MCPConfig,
  McpConfig,
  McpServerConfig,
  OutputOf,
  OutputZodOf,
  RetryConfig,
  RetryErrorKind,
  RunHandle,
  Runner,
  RunnerOf,
  RunnerOfTask,
  RunnerSpawnArgs,
  RunnerSpawnResult,
  RunState,
  SessionRef,
  SessionToken,
  ShareSessionRef,
  TaskCompleteEvent,
  TaskDef,
  TaskErrorEvent,
  TaskMcpOverride,
  TaskMetrics,
  TaskRetryEvent,
  TasksMap,
  TaskStartEvent,
  ToolCallRecord,
  WorkflowCompleteEvent,
  WorkflowDef,
  WorkflowErrorEvent,
  WorkflowEvent,
  WorkflowHooks,
  WorkflowMetrics,
  WorkflowStartEvent,
} from "./types.js";

// Builders
export {
  defineAgent,
  defineWorkflow,
  getRunner,
  getRunners,
  loop,
  registerRunner,
  resolveAgentDef,
  sessionToken,
  shareSessionWith,
  unregisterRunner,
} from "./builders.js";

// Schemas
export {
  safePath,
  validateStaticIdentifier,
  McpConfigSchema,
  McpServerConfigSchema,
} from "./schemas.js";
export type { McpConfigInput, McpServerConfigInput } from "./schemas.js";

// Errors
export {
  AgentFlowError,
  AgentHitlConflictError,
  BudgetExceededError,
  GenericAgentFlowError,
  InvalidIdentifierError,
  LoopMaxIterationsError,
  McpProtocolError,
  McpServerCrashedError,
  McpServerStartFailedError,
  McpTimeoutError,
  McpToolArgInvalidError,
  McpToolCallFailedError,
  McpToolNotFoundError,
  McpToolNotPermittedError,
  NodeMaxRetriesError,
  PathTraversalError,
  PreFlightError,
  SessionMismatchError,
  TimeoutError,
  ToolNotUsedError,
  ValidationError,
} from "./errors.js";
export type { AttemptRecord } from "./errors.js";

// MCP allowlist helpers
export {
  filterMcpTools,
  isMcpToolPermitted,
  mcpToolFqn,
  parseMcpToolFqn,
} from "./mcp-allowlist.js";
export type { McpToolDescriptor } from "./mcp-allowlist.js";

// MCP defaults
export {
  resolveMcpConfig,
  MCP_SAFE_DEFAULTS,
  type ResolvedMcpConfig,
} from "./mcp-defaults.js";
