import * as path from "node:path";
import { z } from "zod";
import { InvalidIdentifierError } from "./errors.js";

const STATIC_IDENTIFIER_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Validates that a string is a safe static identifier for runner/model/mcp.server names.
 * Throws InvalidIdentifierError for unsafe values.
 */
export function validateStaticIdentifier(
  name: string,
  field = "identifier",
): void {
  if (!name || !STATIC_IDENTIFIER_RE.test(name)) {
    throw new InvalidIdentifierError(field, name);
  }
}

/**
 * Zod refinement for safe file paths.
 *
 * Blocks:
 * - Path traversal (.. segments)
 * - Home expansion (~ prefix or ~ segments)
 * - Absolute paths (unless allowAbsolute: true)
 * - Null bytes and control characters
 * - Environment variable expansion ($VAR, ${VAR}, %VAR%)
 * - URL-like strings (file://, http://, etc.)
 * - Windows UNC paths (\\server\share)
 * - Windows drive paths (C:\)
 * - Overlong paths (> 4096 chars)
 * - Trailing/leading whitespace
 * - Empty strings
 *
 * NOTE: This is a syntactic check only. It does NOT guarantee the path exists
 * or that symlinks stay within baseDir. The executor performs runtime realpath
 * checks before tool invocation.
 */
export function safePath(opts?: {
  allowAbsolute?: boolean;
}): z.ZodEffects<z.ZodString, string, string> {
  const allowAbsolute = opts?.allowAbsolute ?? false;

  return z.string().superRefine((val, ctx) => {
    // Empty
    if (val.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Path must not be empty",
      });
      return;
    }

    // Overlong
    if (val.length > 4096) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Path exceeds maximum length of 4096 characters",
      });
      return;
    }

    // Leading/trailing whitespace
    if (val !== val.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Path must not have leading or trailing whitespace",
      });
      return;
    }

    // Null byte
    if (val.includes("\x00")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Path must not contain null bytes",
      });
      return;
    }

    // Control characters (0x01-0x1F, 0x7F)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security check
    if (/[\x01-\x1F\x7F]/.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Path must not contain control characters",
      });
      return;
    }

    // URL-like
    if (
      /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(val) ||
      /^javascript:/i.test(val)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Path must not be a URL",
      });
      return;
    }

    // UNC paths (Windows \\server\share)
    if (val.startsWith("\\\\")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "UNC paths are not allowed",
      });
      return;
    }

    // Single-leading backslash (Windows absolute path \Windows\foo).
    // path.isAbsolute() returns false for these on POSIX — check explicitly.
    if (val.startsWith("\\")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Absolute paths are not allowed",
      });
      return;
    }

    // Windows drive paths (C:\ or C:/)
    if (/^[a-zA-Z]:[/\\]/.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Windows drive paths are not allowed",
      });
      return;
    }

    // Home expansion
    if (val.startsWith("~") || val.includes("/~") || val.includes("\\~")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Home directory expansion is not allowed",
      });
      return;
    }

    // Environment variable expansion
    if (
      /\$[{(]?[A-Za-z_][A-Za-z0-9_]*[)}]?/.test(val) ||
      /%[A-Za-z_][A-Za-z0-9_]*%/.test(val)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Environment variable expansion is not allowed",
      });
      return;
    }

    // Absolute path check
    if (path.isAbsolute(val)) {
      if (!allowAbsolute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Absolute paths are not allowed",
        });
        return;
      }
    }

    // Path traversal — check each normalized segment
    // Normalize using posix to handle mixed separators
    const normalized = val.replace(/\\/g, "/");
    const segments = normalized.split("/").filter((s) => s.length > 0);
    for (const segment of segments) {
      if (segment === "..") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Path must not contain ".." traversal segments',
        });
        return;
      }
    }

    // Double-check with path.normalize
    const normalizedFull = path.normalize(val);
    if (
      normalizedFull.startsWith("..") ||
      normalizedFull.includes(`${path.sep}..`)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Path must not traverse above working directory",
      });
    }
  });
}

// ─── Input sanitization ───────────────────────────────────────────────────────

// Patterns use (?:^|\n) so they match both:
//   • A value that STARTS with the pattern (position 0, no preceding newline)
//   • A pattern that appears after a newline in the middle of a string
// The `m` flag makes ^ match the start of each line in multiline strings.
// The `i` flag covers case variants (system:, SYSTEM:, etc.).
const INJECTION_PATTERNS = [
  /(?:^|\n)\s*---\s*(?:\n|$)/gm,
  /(?:^|\n)\s*System:/gim,
  /(?:^|\n)\s*Human:/gim,
  /(?:^|\n)\s*Assistant:/gim,
];

/**
 * Recursively sanitize string values in an object/array against prompt
 * injection patterns. Only string leaf values are sanitized — objects and
 * arrays are traversed recursively.
 *
 * Patterns are anchored with `(?:^|\n)` so they catch injections that appear
 * at position 0 in a string (no leading newline) as well as mid-string after a
 * newline.
 */
export function sanitizeCtxData(data: unknown): unknown {
  if (typeof data === "string") {
    let sanitized = data;
    for (const pattern of INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, " [SANITIZED] ");
    }
    return sanitized;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeCtxData);
  }

  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = sanitizeCtxData(value);
    }
    return result;
  }

  return data;
}

const STATIC_IDENTIFIER_RE_SCHEMA = /^[a-zA-Z0-9._-]+$/;

/**
 * Zod schema for McpServerConfig (v0.2).
 * Validates MCP server definitions at DSL call time.
 */
export const McpServerConfigSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .refine((v) => STATIC_IDENTIFIER_RE_SCHEMA.test(v), {
        message:
          'MCP server name must match /^[a-zA-Z0-9._-]+$/ (no path separators)',
      }),
    command: z.string().min(1, 'command must not be empty'),
    args: z.array(z.string()).readonly().optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    tools: z.array(z.string()).readonly().optional(),
    // refine is a runtime ZodType map — not Zod-validated itself (opaque)
    transport: z.literal('stdio').optional(),
    mcpCallTimeoutMs: z.number().int().positive().optional(),
    reusePerRunner: z.boolean().optional(),
  })
  .strict();

export type McpServerConfigInput = z.input<typeof McpServerConfigSchema>;

export const McpConfigSchema = z
  .object({
    description: z.string().optional(),
    maxCostUsd: z.number().positive().nullable().optional(),
    maxDurationSec: z.number().positive().nullable().optional(),
    maxTurns: z.number().int().positive().nullable().optional(),
    limits: z.literal("unsafe-unlimited").optional(),
    inputTask: z.string().optional(),
    outputTask: z.string().optional(),
  })
  .strict();

export type McpConfigInput = z.input<typeof McpConfigSchema>;
