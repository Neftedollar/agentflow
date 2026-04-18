// Role loader — read a markdown role file from packages/dev-workflow/roles/.
//
// Role files are plain markdown (no YAML frontmatter requirements beyond what
// the loader parses here). They encode operational knowledge — the prompt body
// is passed verbatim to `defineAgent`'s `prompt` function at workflow build
// time.
//
// ## Why not YAML frontmatter?
//
// We read the raw markdown and expose it as `body`. A lightweight key/value
// pair `key: value` at the top of the file is extracted into `meta` when it
// appears before the first blank line — this keeps roles invoke-able without
// requiring a full YAML parser, while still supporting `model-tier: strategic`
// style hints.
//
// ## File layout expected
//
// ```md
// # Role Name
//
// model-tier: strategic
// mission: one-line summary
//
// ## Mission
// …
// ```
//
// Everything from the top of the file through the last `key: value` line is
// the meta block; everything after is the `body`.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = resolve(__dirname, "../roles");

export interface LoadedRole {
  /** Role name (matches `<name>.md` filename). */
  readonly name: string;
  /** Absolute path the file was read from. */
  readonly path: string;
  /** Key/value meta block at the top of the file (e.g. model-tier, mission). */
  readonly meta: Readonly<Record<string, string>>;
  /** Full markdown body (meta block preserved for prompt context). */
  readonly body: string;
}

// Matches `key: value` where key is kebab-case alphanumeric.
const META_LINE = /^([a-z][a-z0-9-]*)\s*:\s*(.+?)\s*$/i;

/**
 * Load a role prompt from `packages/dev-workflow/roles/<name>.md`.
 *
 * Throws if the file does not exist or the body is empty.
 *
 * The body is returned verbatim — callers pass it directly as the agent
 * prompt body. Meta keys are optional; callers that want, for example, the
 * model tier can read `meta["model-tier"]`.
 */
export async function loadRole(name: string): Promise<LoadedRole> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `loadRole: invalid role name "${name}" — expected kebab-case`,
    );
  }
  const path = join(ROLES_DIR, `${name}.md`);
  const raw = await readFile(path, "utf8");
  const { meta, body } = parseRoleMarkdown(raw);
  if (body.trim().length === 0) {
    throw new Error(`loadRole: role file ${path} has empty body`);
  }
  return { name, path, meta, body };
}

/**
 * Parse a role markdown into a meta map + body.
 *
 * The meta block is a contiguous run of `key: value` lines at the top of the
 * file, optionally preceded by a single `# Heading` line and followed by a
 * blank line. Any non-conforming line ends the meta block; everything from
 * that point onward is the body.
 *
 * Exported for tests.
 */
export function parseRoleMarkdown(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const lines = raw.split(/\r?\n/);
  const meta: Record<string, string> = {};
  let i = 0;

  // Skip an optional leading `# Heading` and blank lines.
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("# ") || line.trim() === "") {
      i += 1;
      continue;
    }
    break;
  }

  // Collect contiguous key: value lines.
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const match = line.match(META_LINE);
    if (!match) break;
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) {
      meta[key.toLowerCase()] = value;
    }
    i += 1;
  }

  return { meta, body: raw };
}

/**
 * Synchronous variant of {@link loadRole}.
 *
 * `defineAgent`'s `prompt` field is typed as `(input) => string` — it cannot
 * `await` — so agents that want to interpolate a role prompt at definition
 * time need a sync loader. Roles are plain files read off the local disk,
 * small (< 10 KB), and loaded at workflow-build time (not per-request), so
 * the blocking read is acceptable.
 *
 * Cached after first read per-name to avoid repeating disk I/O when the
 * same role is referenced by multiple agents.
 */
const _syncCache = new Map<string, LoadedRole>();

export function loadRoleSync(name: string): LoadedRole {
  const cached = _syncCache.get(name);
  if (cached !== undefined) return cached;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `loadRoleSync: invalid role name "${name}" — expected kebab-case`,
    );
  }
  const path = join(ROLES_DIR, `${name}.md`);
  const raw = readFileSync(path, "utf8");
  const { meta, body } = parseRoleMarkdown(raw);
  if (body.trim().length === 0) {
    throw new Error(`loadRoleSync: role file ${path} has empty body`);
  }
  const role: LoadedRole = { name, path, meta, body };
  _syncCache.set(name, role);
  return role;
}

/** Test-only: exposed for unit tests that want to assert the roles dir. */
export const _rolesDir = ROLES_DIR;

/** Test-only: clear the sync cache. */
export function _clearSyncCache(): void {
  _syncCache.clear();
}
