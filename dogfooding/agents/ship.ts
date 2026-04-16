import { defineAgent } from "@ageflow/core";
import { z } from "zod";

/**
 * SHIP step — creates PR and prepares merge.
 * Runs only after VERIFY returns APPROVED.
 * HITL checkpoint is set in the workflow — a human approves before this runs
 * if the plan flagged requiresCeoApproval.
 */
export const shipAgent = defineAgent({
  runner: "claude",
  model: "claude-haiku-4-5-20251001",
  input: z.object({
    issueNumber: z.number(),
    issueTitle: z.string(),
    patch: z.string(),
    filesChanged: z.array(z.string()),
    explanation: z.string(),
    reviewSummary: z.string(),
    branchName: z.string(),
    repoPath: z.string(),
  }),
  output: z.object({
    prUrl: z.string(),
    prNumber: z.number(),
    prTitle: z.string(),
    mergeStrategy: z.enum(["squash", "merge", "rebase"]),
    deployed: z.boolean(),
  }),
  prompt: ({
    issueNumber,
    issueTitle,
    patch,
    filesChanged,
    explanation,
    reviewSummary,
    branchName,
    repoPath,
  }) =>
    `You are a DevOps engineer. Create a PR and merge the following changes.

Repository: ${repoPath}
Branch: ${branchName}
Closes: #${issueNumber} — ${issueTitle}

Changes applied:
${filesChanged.map((f) => `  - ${f}`).join("\n")}

Summary: ${explanation}

Code review verdict: APPROVED
Review notes: ${reviewSummary}

Steps:
1. git add the changed files
2. git commit with message: "fix: closes #${issueNumber} — ${issueTitle}"
3. git push origin ${branchName}
4. gh pr create --title "..." --body "..." --base master
5. gh pr merge --squash

Return JSON with:
- prUrl: the pull request URL
- prNumber: PR number
- prTitle: PR title used
- mergeStrategy: "squash"
- deployed: true if merge succeeded`,
  retry: {
    max: 2,
    on: ["subprocess_error"],
    backoff: "fixed",
  },
});
