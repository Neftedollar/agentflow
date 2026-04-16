import { AgentFlowError } from "@ageflow/core";
import type { McpServerConfig } from "@ageflow/core";

// ─── MissingEnvVarError ───────────────────────────────────────────────────────

export class MissingEnvVarError extends AgentFlowError {
  readonly code = "missing_env_var" as const;
  constructor(
    readonly varName: string,
    options?: ErrorOptions,
  ) {
    super(
      `Environment variable "${varName}" referenced via \${env:${varName}} is not set`,
      options,
    );
  }
}

// ─── expandEnvVars ────────────────────────────────────────────────────────────

/** Pattern matching the supported ${env:NAME} syntax only. */
const ENV_TEMPLATE_RE = /\$\{env:([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Bare `$NAME` (no curly braces) is rejected as a security measure — it is
 * ambiguous with shell variable expansion and easy to mis-use.
 */
const BARE_VAR_RE = /\$[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Expand `${env:NAME}` placeholders in a string value using the provided
 * env map. Rejects bare `$NAME` syntax. Throws `MissingEnvVarError` when a
 * referenced variable is not present in the map.
 */
export function expandEnvVars(
  value: string,
  env: Readonly<Record<string, string>>,
): string {
  // Reject bare $NAME (security measure — must use ${env:NAME} form).
  if (BARE_VAR_RE.test(value)) {
    throw new MissingEnvVarError(
      value.match(BARE_VAR_RE)?.[0]?.slice(1) ?? "unknown",
      {
        cause: new Error(
          "Bare $VAR syntax is not supported. Use ${env:NAME} instead.",
        ),
      },
    );
  }

  return value.replace(ENV_TEMPLATE_RE, (_match, name: string) => {
    if (!(name in env)) {
      throw new MissingEnvVarError(name);
    }
    return env[name] as string;
  });
}

// ─── expandServerEnv ──────────────────────────────────────────────────────────

/**
 * Expand all `${env:X}` references in a McpServerConfig's command, args and
 * env values. Returns a new config with all placeholders resolved.
 */
export function expandServerEnv(
  server: McpServerConfig,
  env: Readonly<Record<string, string | undefined>>,
): McpServerConfig {
  // Filter out undefined values so we can pass a clean Record<string,string>
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) cleanEnv[k] = v;
  }

  const expandedCommand = expandEnvVars(server.command, cleanEnv);

  const expandedArgs = server.args?.map((arg) => expandEnvVars(arg, cleanEnv));

  const expandedEnv: Record<string, string> | undefined = server.env
    ? Object.fromEntries(
        Object.entries(server.env).map(([k, v]) => [
          k,
          expandEnvVars(v, cleanEnv),
        ]),
      )
    : undefined;

  return {
    ...server,
    command: expandedCommand,
    ...(expandedArgs !== undefined ? { args: expandedArgs } : {}),
    ...(expandedEnv !== undefined ? { env: expandedEnv } : {}),
  };
}
