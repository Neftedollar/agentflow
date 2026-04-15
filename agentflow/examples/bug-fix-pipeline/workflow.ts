import {
  defineWorkflow,
  loop,
  registerRunner,
  sessionToken,
} from "@agentflow/core";
import type { CtxFor } from "@agentflow/core";
import { ClaudeRunner } from "@agentflow/runner-claude";
import { analyzeAgent } from "./agents/analyze.js";
import { evalAgent } from "./agents/eval.js";
import { fixAgent } from "./agents/fix.js";
import { summarizeAgent } from "./agents/summarize.js";

// Register runner (top-level side effect — runs when file is imported by agentwf or Node)
registerRunner("claude", new ClaudeRunner());

// Session: fix and eval share conversation context across loop iterations
const fixSession = sessionToken("fix-context", "claude");

type IssueShape = {
  id: string;
  file: string;
  description: string;
  severity: "high" | "medium" | "low";
};

// ─── Inner loop: fix → eval ───────────────────────────────────────────────────
//
// The loop runs until eval reports satisfied === true, or until max iterations.
// context: "persistent" reuses session handles across iterations so the model
// retains conversation context and can reference its previous attempt.
//
// The loop.input function extracts the issue from the outer analyze output and
// merges it into innerCtx as ctx["issue"] — loop tasks access it via that key.

const fixLoop = loop({
  dependsOn: ["analyze"] as const,
  max: 3,
  context: "persistent",
  until: (ctx: unknown) => {
    const c = ctx as Record<string, { output: { satisfied?: boolean } }>;
    return c.eval?.output?.satisfied === true;
  },
  input: (ctx: unknown) => {
    const c = ctx as Record<string, { output: unknown }>;
    const analyzeOut = c.analyze?.output as
      | { issues?: IssueShape[] }
      | undefined;
    // Pass the first issue into the loop as ctx["issue"] for fix and eval tasks
    const issue: IssueShape = analyzeOut?.issues?.[0] ?? {
      id: "none",
      file: "unknown",
      description: "no issues found",
      severity: "low",
    };
    return { issue };
  },
  tasks: {
    fix: {
      agent: fixAgent,
      session: fixSession,
      // ctx["issue"] is provided by the loop.input function above.
      // ctx["__loop_feedback__"] carries the previous iteration's full output (iteration ≥ 2).
      input: (ctx: Record<string, { output: unknown }>) => {
        const c = ctx;
        const issue = c.issue?.output as IssueShape | undefined;
        // On retry: surface the previous patch so the agent knows what didn't work
        const feedback = c.__loop_feedback__?.output as
          | Record<string, { output: unknown }>
          | undefined;
        const prevPatch = (
          feedback?.fix?.output as { patch?: string } | undefined
        )?.patch;
        return {
          issue: issue ?? {
            id: "none",
            file: "unknown",
            description: "no issues",
            severity: "low" as const,
          },
          ...(prevPatch !== undefined ? { previousAttempt: prevPatch } : {}),
        };
      },
    },
    eval: {
      agent: evalAgent,
      dependsOn: ["fix"] as const,
      session: fixSession,
      input: (ctx: Record<string, { output: unknown }>) => {
        const c = ctx;
        const issue = c.issue?.output as IssueShape | undefined;
        const fixOut = c.fix?.output as
          | { patch?: string; explanation?: string }
          | undefined;
        return {
          issue: issue ?? {
            id: "none",
            file: "unknown",
            description: "no issues",
            severity: "low" as const,
          },
          patch: fixOut?.patch ?? "",
          explanation: fixOut?.explanation ?? "",
        };
      },
    },
  },
});

// ─── Workflow ─────────────────────────────────────────────────────────────────
//
// Outer DAG: analyze → fixLoop → summarize.
// summarize depends on both analyze (for the issue list) and fixLoop (for completion gate).

// Explicit task map type enables CtxFor usage without circular reference.
type WorkflowTasks = {
  analyze: {
    agent: typeof analyzeAgent;
    input: { repoPath: string; focus: string };
  };
  fixLoop: typeof fixLoop;
  summarize: {
    agent: typeof summarizeAgent;
    dependsOn: readonly ["analyze", "fixLoop"];
  };
};

export default defineWorkflow({
  name: "bug-fix-pipeline",
  tasks: {
    analyze: {
      agent: analyzeAgent,
      input: { repoPath: "./src", focus: "security and null safety" },
    },
    fixLoop,
    summarize: {
      agent: summarizeAgent,
      dependsOn: ["analyze", "fixLoop"] as const,
      // CtxFor<WorkflowTasks, "summarize"> gives fully-typed output access.
      // The cast is safe — executor populates ctx with exactly this shape.
      // Without the cast, ctx.analyze.output is typed as unknown (BoundCtx limitation).
      input: (ctx: unknown) => {
        type Ctx = CtxFor<WorkflowTasks, "summarize">;
        const typed = ctx as unknown as Ctx;
        return {
          originalIssues: typed.analyze.output.issues,
          fixResult: typed.fixLoop.output,
        };
      },
    },
  },
});
