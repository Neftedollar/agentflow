// GitHub issue loader — wraps the `gh` CLI via execa.
// Using gh (not octokit) keeps auth in the CLI credential store and avoids a
// separate token. execa is a thin async wrapper around child_process.
//
// Real calls are made here (no LLM). Safe to run in sub-PR 1+.

import { execa } from "execa";
import { type Issue, IssueSchema, type PipelineType } from "./types.js";

/** Load a GitHub issue by number. Throws on network error or not-found. */
export async function loadIssue(number: number): Promise<Issue> {
  const { stdout } = await execa("gh", [
    "issue",
    "view",
    String(number),
    "--json",
    "number,title,body,labels,state,url",
  ]);

  const raw = JSON.parse(stdout) as Record<string, unknown>;

  // gh returns labels as objects {name, color, ...} — keep only name strings.
  if (Array.isArray(raw.labels)) {
    raw.labels = (raw.labels as Array<{ name: string }>).map((l) => l.name);
  }

  // gh returns state as uppercase ("OPEN"/"CLOSED") — normalise to lowercase.
  if (typeof raw.state === "string") {
    raw.state = raw.state.toLowerCase();
  }

  return IssueSchema.parse(raw);
}

/**
 * Determine pipeline type from issue labels.
 *
 * Label precedence:
 *   bug / bugfix  → bugfix
 *   release       → release
 *   docs / content → docs
 *   (everything else) → feature
 */
export function determinePipeline(issue: Issue): PipelineType {
  const labels = new Set(issue.labels.map((l) => l.toLowerCase()));
  if (labels.has("bug") || labels.has("bugfix")) return "bugfix";
  if (labels.has("release")) return "release";
  if (labels.has("docs") || labels.has("content")) return "docs";
  return "feature";
}

/** Post a comment on an issue (used for gate-progress markers in sub-PR 4+). */
export async function commentIssue(
  number: number,
  body: string,
): Promise<void> {
  await execa("gh", ["issue", "comment", String(number), "--body", body]);
}
