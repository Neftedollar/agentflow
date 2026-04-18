// Git worktree management for dev-workflow pipeline isolation.
// Each issue run gets its own worktree → its own branch. After SHIP (merge)
// the worktree is removed. Removal is deferred to sub-PR 4+.

import { basename, dirname, join } from "node:path";
import { execa } from "execa";
import type { Issue } from "./types.js";

/** Derive a branch name for the issue. Max 80 chars (git + GitHub limit). */
export function branchName(
  issue: Pick<Issue, "number" | "title" | "labels">,
): string {
  const prefix = pickPrefix(issue.labels);
  const slug = slugify(issue.title);
  const branch = `${prefix}/${issue.number}-${slug}`;
  return branch.length > 80 ? branch.slice(0, 80) : branch;
}

/** Sibling-directory path for the worktree (e.g. ../agents-workflow-wt-194). */
export function worktreePath(repoRoot: string, issueNumber: number): string {
  const parent = dirname(repoRoot);
  const name = basename(repoRoot);
  return join(parent, `${name}-wt-${issueNumber}`);
}

/**
 * Create a git worktree for the given issue.
 *
 * Stub: logs the would-be path and branch without calling git.
 * Real implementation (execa git worktree add) lands in sub-PR 4.
 *
 * @returns Absolute path where the worktree would be created.
 */
export async function createWorktree(
  repoRoot: string,
  issue: Issue,
): Promise<string> {
  const path = worktreePath(repoRoot, issue.number);
  const branch = branchName(issue);

  // Sub-PR 1: dry stub — log only, no actual git call.
  console.log(
    `[worktree] would create: git worktree add ${path} -b ${branch} master`,
  );

  // Sub-PR 4: replace the log above with the real call below.
  // await execa("git", ["worktree", "add", path, "-b", branch, "master"], {
  //   cwd: repoRoot,
  // });

  return path;
}

/** Remove a worktree after merge/abort. Stub — real call lands in sub-PR 4. */
export async function removeWorktree(
  repoRoot: string,
  issueNumber: number,
): Promise<void> {
  const path = worktreePath(repoRoot, issueNumber);
  console.log(`[worktree] would remove: git worktree remove ${path} --force`);
  // Sub-PR 4: await execa("git", ["worktree", "remove", path, "--force"], { cwd: repoRoot });
}

function pickPrefix(labels: string[]): string {
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.includes("bug") || lower.includes("bugfix")) return "bug";
  if (lower.includes("release")) return "release";
  if (lower.includes("docs") || lower.includes("content")) return "docs";
  return "feat";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}
