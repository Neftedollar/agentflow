import { ErrorCode, McpServerError } from "./errors.js";
import type {
  ConcurrencyConfig,
  ResolvedConcurrencyConfig,
  WorkflowConcurrencyConfig,
} from "./types.js";

export interface ConcurrencyPermit {
  release(): void;
}

export interface ConcurrencyController {
  acquireStart(workflowName: string): ConcurrencyPermit | McpServerError;
  acquireJob(workflowName: string): ConcurrencyPermit | McpServerError;
}

const RESOLVED_CONCURRENCY = Symbol("ageflow.resolvedConcurrency");

type InternalResolvedConcurrencyConfig = ResolvedConcurrencyConfig & {
  readonly [RESOLVED_CONCURRENCY]: true;
};

type Kind = "start" | "job";

class Counter {
  private _active = 0;

  constructor(readonly limit: number | null) {}

  get active(): number {
    return this._active;
  }

  tryAcquire(): boolean {
    if (this.limit !== null && this._active >= this.limit) {
      return false;
    }
    this._active += 1;
    return true;
  }

  release(): void {
    if (this._active > 0) {
      this._active -= 1;
    }
  }
}

const controllerCache = new WeakMap<
  InternalResolvedConcurrencyConfig,
  ConcurrencyController
>();

export function resolveConcurrencyConfig(
  config?: ConcurrencyConfig | ResolvedConcurrencyConfig,
): ResolvedConcurrencyConfig {
  if (config !== undefined && isResolvedConcurrencyConfig(config)) {
    return config;
  }

  const raw = (config ?? {}) as ConcurrencyConfig;
  const workflows: Record<string, WorkflowConcurrencyConfig> = {};

  for (const [workflowName, workflowConfig] of Object.entries(
    raw.workflows ?? {},
  )) {
    workflows[workflowName] = normalizeWorkflowConfig(
      workflowConfig,
      `workflows.${workflowName}`,
    );
  }

  for (const [workflowName, maxConcurrentStarts] of Object.entries(
    (raw.perWorkflow ?? {}) as Readonly<Record<string, number | null>>,
  )) {
    const nextConfig = workflows[workflowName] ?? {};
    workflows[workflowName] = {
      ...nextConfig,
      maxConcurrentStarts: normalizeLimit(
        maxConcurrentStarts,
        `perWorkflow.${workflowName}`,
      ),
    };
  }

  const resolved = {
      maxConcurrentStarts:
        raw.maxConcurrentStarts !== undefined
          ? normalizeLimit(raw.maxConcurrentStarts, "maxConcurrentStarts")
          : raw.maxConcurrentJobs !== undefined
            ? normalizeLimit(raw.maxConcurrentJobs, "maxConcurrentJobs")
        : 1,
    maxConcurrentJobs:
      raw.maxConcurrentJobs !== undefined
        ? normalizeLimit(raw.maxConcurrentJobs, "maxConcurrentJobs")
        : null,
    workflows,
  } as InternalResolvedConcurrencyConfig;

  Object.defineProperty(resolved, RESOLVED_CONCURRENCY, {
    value: true,
    enumerable: false,
    configurable: false,
  });

  return resolved;
}

export function createConcurrencyController(
  config?: ConcurrencyConfig | ResolvedConcurrencyConfig,
): ConcurrencyController {
  const resolved = resolveConcurrencyConfig(
    config,
  ) as InternalResolvedConcurrencyConfig;
  const cached = controllerCache.get(resolved);
  if (cached !== undefined) {
    return cached;
  }

  const serverCounters = {
    start: new Counter(resolved.maxConcurrentStarts),
    job: new Counter(resolved.maxConcurrentJobs),
  };
  const workflowCounters = new Map<string, Partial<Record<Kind, Counter>>>();

  const controller: ConcurrencyController = {
    acquireStart(workflowName: string) {
      return acquire("start", workflowName);
    },
    acquireJob(workflowName: string) {
      return acquire("job", workflowName);
    },
  };

  controllerCache.set(resolved, controller);
  return controller;

  function acquire(
    kind: Kind,
    workflowName: string,
  ): ConcurrencyPermit | McpServerError {
    const workflowConfig = resolved.workflows[workflowName];
    const workflowLimit = workflowConfig?.[limitFieldFor(kind)];
    const workflowCounter =
      workflowLimit !== undefined
        ? getWorkflowCounter(workflowName, kind, workflowLimit)
        : undefined;

    if (workflowCounter !== undefined && !workflowCounter.tryAcquire()) {
      return makeLimitError({
        code: ErrorCode.BUSY,
        scope: "workflow",
        kind,
        workflowName,
        limit: workflowCounter.limit,
        active: workflowCounter.active,
      });
    }

    const serverCounter = serverCounters[kind];
    if (!serverCounter.tryAcquire()) {
      workflowCounter?.release();
      return makeLimitError({
        code: ErrorCode.BUSY,
        scope: "server",
        kind,
        limit: serverCounter.limit,
        active: serverCounter.active,
      });
    }

    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        serverCounter.release();
        workflowCounter?.release();
      },
    };
  }

  function getWorkflowCounter(
    workflowName: string,
    kind: Kind,
    limit: number | null,
  ): Counter {
    const existing = workflowCounters.get(workflowName);
    const counter = existing?.[kind];
    if (counter !== undefined) {
      return counter;
    }

    const next = new Counter(limit);
    const merged = { ...(existing ?? {}), [kind]: next } as Partial<
      Record<Kind, Counter>
    >;
    workflowCounters.set(workflowName, merged);
    return next;
  }
}

function isResolvedConcurrencyConfig(
  config: ConcurrencyConfig | ResolvedConcurrencyConfig,
): config is InternalResolvedConcurrencyConfig {
  return (
    typeof config === "object" &&
    config !== null &&
    RESOLVED_CONCURRENCY in config
  );
}

function normalizeWorkflowConfig(
  config: WorkflowConcurrencyConfig,
  path: string,
): WorkflowConcurrencyConfig {
  const maxConcurrentStarts =
    config.maxConcurrentStarts !== undefined
      ? normalizeLimit(
          config.maxConcurrentStarts,
          `${path}.maxConcurrentStarts`,
        )
      : config.maxConcurrentJobsPerWorkflow !== undefined
        ? normalizeLimit(
            config.maxConcurrentJobsPerWorkflow,
            `${path}.maxConcurrentJobsPerWorkflow`,
          )
        : undefined;
  return {
    ...(maxConcurrentStarts !== undefined ? { maxConcurrentStarts } : {}),
    ...(config.maxConcurrentJobs !== undefined
      ? {
          maxConcurrentJobs: normalizeLimit(
            config.maxConcurrentJobs,
            `${path}.maxConcurrentJobs`,
          ),
        }
      : {}),
  };
}

function normalizeLimit(value: number | null, path: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${path} must be a positive integer${value === null ? " or null" : ""}, got: ${String(value)}`,
    );
  }
  return value;
}

function limitFieldFor(
  kind: Kind,
): "maxConcurrentStarts" | "maxConcurrentJobs" {
  return kind === "start" ? "maxConcurrentStarts" : "maxConcurrentJobs";
}

function makeLimitError(args: {
  code: typeof ErrorCode.BUSY;
  scope: "server" | "workflow";
  kind: Kind;
  limit: number | null;
  active: number;
  workflowName?: string;
}): McpServerError {
  const message =
    args.scope === "workflow"
      ? `Workflow "${args.workflowName ?? "unknown"}" ${args.kind} concurrency limit reached (limit=${args.limit})`
      : `Server ${args.kind} concurrency limit reached (limit=${args.limit})`;

  return new McpServerError(args.code, message, {
    scope: args.scope,
    kind: args.kind,
    limit: args.limit,
    active: args.active,
    ...(args.workflowName !== undefined
      ? { workflowName: args.workflowName }
      : {}),
  });
}
