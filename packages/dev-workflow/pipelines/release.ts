// Release pipeline — BUMP → CHANGELOG → PUBLISH → CLEANUP.
//
// All nodes are defineFunction — release mechanics are deterministic.
// An LLM-driven npm publish is a footgun (wrong package order → partial release).
//
// PR E: all 4 nodes are real defineFunction implementations.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineFunction, defineWorkflowFactory } from "@ageflow/core";
import { execa } from "execa";
import { z } from "zod";
import type { WorkflowInput } from "../shared/types.js";

// Publish order — consumer packages last. Must match
// .claude/commands/ageflow-orchestrator.md#package-dependency-order.
const PUBLISH_ORDER = [
  "@ageflow/core",
  "@ageflow/executor",
  "@ageflow/runner-claude",
  "@ageflow/runner-codex",
  "@ageflow/runner-api",
  "@ageflow/runner-anthropic",
  "@ageflow/testing",
  "@ageflow/server",
  "@ageflow/mcp-server",
  "@ageflow/learning",
  "@ageflow/learning-sqlite",
  "@ageflow/cli",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findPackageDir(
  repoRoot: string,
  pkgName: string,
): Promise<string | null> {
  const roots = [
    join(repoRoot, "packages"),
    join(repoRoot, "packages/runners"),
  ];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgJsonPath = join(root, entry, "package.json");
      try {
        const content = await readFile(pkgJsonPath, "utf8");
        const parsed = JSON.parse(content);
        if (parsed.name === pkgName) return join(root, entry);
      } catch {
        // skip unreadable entries
      }
    }
  }
  return null;
}

function semverBump(
  current: string,
  kind: "patch" | "minor" | "major",
): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`invalid semver: ${current}`);
  const [, majStr, minStr, patStr] = match;
  let maj = Number(majStr);
  let min = Number(minStr);
  let pat = Number(patStr);
  if (kind === "major") {
    maj += 1;
    min = 0;
    pat = 0;
  } else if (kind === "minor") {
    min += 1;
    pat = 0;
  } else {
    pat += 1;
  }
  return `${maj}.${min}.${pat}`;
}

// ── Task functions ────────────────────────────────────────────────────────────

// BUMP — reads labels to determine semver kind, then rewrites package.json
// versions for each affected package.
const bumpFn = defineFunction({
  name: "bump",
  input: z.object({
    issueNumber: z.number().int().positive(),
    labels: z.array(z.string()),
    issueBody: z.string(),
    worktreePath: z.string(),
    // Caller specifies which packages to bump. Empty = no-op; operator fills.
    affectedPackages: z.array(z.string()),
  }),
  output: z.object({
    bumpKind: z.enum(["patch", "minor", "major"]),
    bumps: z.array(
      z.object({
        package: z.string(),
        before: z.string(),
        after: z.string(),
      }),
    ),
  }),
  execute: async (input) => {
    if (input.affectedPackages.length === 0) {
      throw new Error(
        "affectedPackages is empty — no packages to bump. " +
          "The release issue body must mention at least one @ageflow/<pkg>.",
      );
    }

    // Determine bump kind from labels
    const labelLower = input.labels.map((l) => l.toLowerCase());
    let bumpKind: "patch" | "minor" | "major" = "patch";
    if (labelLower.includes("breaking") || labelLower.includes("major")) {
      bumpKind = "major";
    } else if (labelLower.includes("feature") || labelLower.includes("minor")) {
      bumpKind = "minor";
    }

    const bumps: { package: string; before: string; after: string }[] = [];
    for (const pkg of input.affectedPackages) {
      const pkgDir = await findPackageDir(input.worktreePath, pkg);
      if (!pkgDir) continue;

      const pkgJsonPath = join(pkgDir, "package.json");
      const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
      const before = pkgJson.version as string;
      const after = semverBump(before, bumpKind);
      pkgJson.version = after;
      await writeFile(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

      bumps.push({ package: pkg, before, after });
    }

    return { bumpKind, bumps };
  },
});

// CHANGELOG — appends a dated section to CHANGELOG.md at repo root.
const changelogFn = defineFunction({
  name: "changelog",
  input: z.object({
    bumpKind: z.enum(["patch", "minor", "major"]),
    bumps: z.array(
      z.object({
        package: z.string(),
        before: z.string(),
        after: z.string(),
      }),
    ),
    worktreePath: z.string(),
  }),
  output: z.object({
    changelogPath: z.string(),
    entryLines: z.number().int().nonnegative(),
  }),
  execute: async (input) => {
    const changelogPath = join(input.worktreePath, "CHANGELOG.md");
    const today = new Date().toISOString().slice(0, 10);
    const lines = [
      `## ${today} — ${input.bumpKind} release`,
      "",
      ...input.bumps.map((b) => `- \`${b.package}\` ${b.before} → ${b.after}`),
      "",
    ];

    let existing = "";
    try {
      existing = await readFile(changelogPath, "utf8");
    } catch {
      // File does not exist yet — that's fine.
    }

    const header = existing.startsWith("# ") ? "" : "# Changelog\n\n";
    await writeFile(
      changelogPath,
      `${header}${lines.join("\n")}${existing ? `\n${existing.replace(/^# Changelog\s*\n/, "")}` : ""}`,
    );

    return { changelogPath, entryLines: lines.length };
  },
});

// PUBLISH — runs `npm publish` in PUBLISH_ORDER for each bumped package.
// plan: true prints commands without executing — safe dry-run mode.
const publishFn = defineFunction({
  name: "publish",
  input: z.object({
    bumps: z.array(
      z.object({
        package: z.string(),
        before: z.string(),
        after: z.string(),
      }),
    ),
    worktreePath: z.string(),
    // Safety: if true, only prints commands (no actual publish).
    plan: z.boolean(),
  }),
  output: z.object({
    published: z.array(z.string()),
    skipped: z.array(z.object({ package: z.string(), reason: z.string() })),
  }),
  execute: async (input) => {
    const published: string[] = [];
    const skipped: { package: string; reason: string }[] = [];

    const bumpedNames = new Set(input.bumps.map((b) => b.package));

    for (const pkgName of PUBLISH_ORDER) {
      if (!bumpedNames.has(pkgName)) continue;

      if (input.plan) {
        // In plan mode, skip actual directory lookup — it's a dry-run.
        console.log(
          "[publish] would run: npm publish --access public (cwd: packages/...)",
        );
        published.push(pkgName);
        continue;
      }

      const pkgDir = await findPackageDir(input.worktreePath, pkgName);
      if (!pkgDir) {
        skipped.push({ package: pkgName, reason: "package.json not found" });
        continue;
      }

      try {
        await execa("npm", ["publish", "--access", "public"], { cwd: pkgDir });
        published.push(pkgName);
      } catch (err) {
        skipped.push({
          package: pkgName,
          reason: (err as Error).message.slice(0, 200),
        });
      }
    }

    if (!input.plan && skipped.length > 0) {
      const details = skipped
        .map((s) => `${s.package}: ${s.reason}`)
        .join("; ");
      throw new Error(
        `publish failed for ${skipped.length} package(s): ${details}`,
      );
    }

    return { published, skipped };
  },
});

// CLEANUP — tags the release commit in the worktree. No auto-push — operator
// pushes the tag manually after confirming the publish succeeded.
const cleanupFn = defineFunction({
  name: "cleanup",
  input: z.object({
    bumpKind: z.enum(["patch", "minor", "major"]),
    bumps: z.array(z.object({ package: z.string(), after: z.string() })),
    worktreePath: z.string(),
  }),
  output: z.object({
    tag: z.string(),
    pushed: z.boolean(),
  }),
  execute: async (input) => {
    const today = new Date().toISOString().slice(0, 10);
    const tag = `release-${today}-${input.bumpKind}`;
    const message = input.bumps
      .map((b) => `${b.package}@${b.after}`)
      .join("\n");

    try {
      await execa("git", ["tag", "-a", tag, "-m", message], {
        cwd: input.worktreePath,
      });
    } catch (err) {
      console.warn(`[cleanup] tag failed: ${(err as Error).message}`);
    }

    // Don't push the tag — operator does that manually after confirming publish.
    return { tag, pushed: false };
  },
});

// ── Pipeline factory ──────────────────────────────────────────────────────────

export const createReleasePipeline = defineWorkflowFactory(
  (input: WorkflowInput) => ({
    name: "release-pipeline",
    tasks: {
      // BUMP — determine semver kind from labels; rewrite package.json versions.
      bump: {
        fn: bumpFn,
        input: () => {
          // Parse affected packages from the issue body.
          // Convention: the release issue body mentions @ageflow/<pkg> names
          // (e.g. in a fenced list or inline). De-duplicate with Set.
          const pkgMatches = input.issue.body.match(/@ageflow\/[a-z-]+/g) ?? [];
          const affectedPackages = [...new Set(pkgMatches)];
          return {
            issueNumber: input.issue.number,
            labels: [...input.issue.labels],
            issueBody: input.issue.body,
            worktreePath: input.worktreePath,
            affectedPackages,
          };
        },
      },

      // CHANGELOG — append a dated section to CHANGELOG.md at repo root.
      changelog: {
        fn: changelogFn,
        dependsOn: ["bump"] as const,
        input: (ctx: {
          bump: {
            output: {
              bumpKind: "patch" | "minor" | "major";
              bumps: readonly {
                package: string;
                before: string;
                after: string;
              }[];
            };
          };
        }) => ({
          bumpKind: ctx.bump.output.bumpKind,
          bumps: [...ctx.bump.output.bumps],
          worktreePath: input.worktreePath,
        }),
      },

      // PUBLISH — npm publish in PUBLISH_ORDER. dryRun gates plan:true mode.
      // dependsOn both changelog (ordering) and bump (for the bumps list).
      publish: {
        fn: publishFn,
        dependsOn: ["changelog", "bump"] as const,
        input: (ctx: {
          bump: {
            output: {
              bumps: readonly {
                package: string;
                before: string;
                after: string;
              }[];
            };
          };
        }) => ({
          bumps: [...ctx.bump.output.bumps],
          worktreePath: input.worktreePath,
          plan: input.dryRun ?? false,
        }),
      },

      // CLEANUP — git tag the release commit. Operator pushes the tag manually.
      // dependsOn both publish (ordering) and bump (for bumpKind + bumps).
      cleanup: {
        fn: cleanupFn,
        dependsOn: ["publish", "bump"] as const,
        input: (ctx: {
          bump: {
            output: {
              bumpKind: "patch" | "minor" | "major";
              bumps: readonly { package: string; after: string }[];
            };
          };
        }) => ({
          bumpKind: ctx.bump.output.bumpKind,
          bumps: ctx.bump.output.bumps.map((b) => ({
            package: b.package,
            after: b.after,
          })),
          worktreePath: input.worktreePath,
        }),
      },
    },
  }),
);

// Export helpers and task functions for use in tests.
export { semverBump, findPackageDir, bumpFn, publishFn, PUBLISH_ORDER };
