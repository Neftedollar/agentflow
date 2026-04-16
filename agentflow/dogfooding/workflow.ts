/**
 * Dogfooding: AgentFlow dev pipeline modelled as an ageflow workflow.
 *
 * Pipeline: PLAN → BUILD_LOOP (build ↔ test, max 3×) → VERIFY → SHIP
 *
 * Mirrors the orchestrator process from docs/process.md:
 * - Opus for strategic steps (plan, verify) — high reasoning quality
 * - Sonnet for execution (build) — fast and capable
 * - Haiku for mechanical steps (test, ship) — speed over depth
 * - Loop with feedback: BUILD retries up to 3× with test failure as context
 * - HITL: CEO approval gate before SHIP if plan flags requiresCeoApproval
 * - Session: build and test share context within each loop iteration
 */

import {
  defineWorkflow,
  loop,
  registerRunner,
  sessionToken,
} from "@ageflow/core";
import type { CtxFor } from "@ageflow/core";
import { ClaudeRunner } from "@ageflow/runner-claude";

import { buildAgent } from "./agents/build.js";
import { planAgent } from "./agents/plan.js";
import { shipAgent } from "./agents/ship.js";
import { testAgent } from "./agents/test.js";
import { verifyAgent } from "./agents/verify.js";

registerRunner("claude", new ClaudeRunner());

// Build and test share session — the model remembers previous attempts
// when generating the next fix, avoiding repeating the same mistakes.
const buildSession = sessionToken("build-context", "claude");

// ─── Types ────────────────────────────────────────────────────────────────────

type PlanOutput = {
  summary: string;
  affectedPackages: string[];
  affectedFiles: string[];
  steps: Array<{ order: number; description: string; file?: string }>;
  acceptanceCriteria: string[];
  estimatedComplexity: "trivial" | "small" | "medium" | "large";
  requiresCeoApproval: boolean;
  ceoApprovalReason?: string;
};

type BuildOutput = {
  patch: string;
  filesChanged: string[];
  explanation: string;
  confidence: number;
};

type TestOutput = {
  passed: boolean;
  totalTests: number;
  failedTests: number;
  failureDetails?: string;
  lintErrors?: string;
  typecheckErrors?: string;
};

// ─── Inner loop: BUILD ↔ TEST ─────────────────────────────────────────────────
//
// Runs until tests pass or max 3 iterations.
// context: "persistent" — build and test share the same session handle across
// iterations so the model accumulates context ("last time X failed, try Y").
//
// Input function extracts the plan from outer ctx and previous test failure
// (stored in __loop_feedback__) to give build the full retry context.

const buildLoop = loop({
  dependsOn: ["plan"] as const,
  max: 3,
  context: "persistent",

  until: (ctx: unknown) => {
    const c = ctx as Record<string, { output: TestOutput }>;
    return c.test?.output?.passed === true;
  },

  input: (ctx: unknown) => {
    type OuterCtx = {
      plan?: { output: PlanOutput };
      __loop_feedback__?: { output: Record<string, { output: unknown }> };
    };
    const c = ctx as OuterCtx;
    const plan = c.plan?.output;

    // On retry iterations, surface the previous test failure to build
    const feedback = c.__loop_feedback__?.output;
    const prevTest = feedback?.test?.output as TestOutput | undefined;
    const prevBuild = feedback?.build?.output as BuildOutput | undefined;

    return {
      plan: plan ?? {
        summary: "unknown",
        affectedFiles: [],
        steps: [],
        acceptanceCriteria: [],
      },
      repoPath: ".",
      testFailure:
        prevTest?.passed === false
          ? [
              prevTest.failureDetails,
              prevTest.lintErrors,
              prevTest.typecheckErrors,
            ]
              .filter(Boolean)
              .join("\n")
          : undefined,
      previousPatch: prevBuild?.patch,
    };
  },

  tasks: {
    build: {
      agent: buildAgent,
      session: buildSession,
      // input comes from the loop.input function above (merged into innerCtx)
    },
    test: {
      agent: testAgent,
      dependsOn: ["build"] as const,
      session: buildSession,
      input: (ctx: unknown) => {
        type InnerCtx = {
          build?: { output: BuildOutput };
          affectedPackages?: { output: string[] };
        };
        const c = ctx as InnerCtx;
        const plan = (ctx as { plan?: { output: PlanOutput } }).plan?.output;
        return {
          repoPath: ".",
          affectedPackages: plan?.affectedPackages ?? [],
          patch: c.build?.output.patch ?? "",
        };
      },
    },
  },
});

// ─── Workflow ─────────────────────────────────────────────────────────────────

type WorkflowTasks = {
  plan: typeof planAgent;
  buildLoop: typeof buildLoop;
  verify: typeof verifyAgent;
  ship: typeof shipAgent;
};

export default defineWorkflow({
  name: "dev-pipeline",

  mcp: {
    description:
      "Run the full ageflow dev pipeline: plan → build → test → verify → ship.",
    maxCostUsd: 10,
    maxDurationSec: 1800,
    maxTurns: 100,
    inputTask: "plan",
    outputTask: "ship",
  },

  // CEO approval gate: if plan flags requiresCeoApproval, pause before SHIP
  hooks: {
    onCheckpoint: async (taskName: string) => {
      // The checkpoint fires before the task runs.
      // In a real setup this would send a Slack/Telegram message and wait.
      // For local runs, auto-approve (return true).
      console.log(`[HITL] Checkpoint for task: ${taskName}`);
      return true;
    },
  },

  tasks: {
    // ── PLAN ──────────────────────────────────────────────────────────────────
    plan: {
      agent: planAgent,
      input: {
        issue: {
          number: 42,
          title: "Add support for parallel task execution metrics",
          body: `When multiple tasks run in parallel, we currently have no way to see
individual task latency vs. the batch latency. Add per-task timing to
WorkflowResult so users can identify bottlenecks.

Acceptance criteria:
- WorkflowResult includes taskMetrics: Record<string, { startedAt, completedAt, latencyMs }>
- agentwf run prints a timing summary at the end
- Existing tests pass`,
          labels: ["enhancement", "executor"],
        },
        repoPath: ".",
      },
    },

    // ── BUILD LOOP ────────────────────────────────────────────────────────────
    // build → test → (if failed) build again with failure feedback → ...
    buildLoop,

    // ── VERIFY ────────────────────────────────────────────────────────────────
    verify: {
      agent: verifyAgent,
      dependsOn: ["buildLoop"] as const,
      hitl: {
        // Pause if confidence was low — human should check before we stamp APPROVED
        mode: "permissions",
        tools: [],
      },
      input: (ctx: unknown) => {
        type Ctx = CtxFor<WorkflowTasks, "verify">;
        const typed = ctx as unknown as Ctx;

        const loopOut = typed.buildLoop.output as Record<
          string,
          { output: unknown }
        >;
        const build = loopOut.build?.output as BuildOutput | undefined;
        const test = loopOut.test?.output as TestOutput | undefined;
        const plan = typed.plan.output;

        return {
          patch: build?.patch ?? "",
          filesChanged: build?.filesChanged ?? [],
          explanation: build?.explanation ?? "",
          acceptanceCriteria: plan.acceptanceCriteria,
          testResults: {
            passed: test?.passed ?? false,
            totalTests: test?.totalTests ?? 0,
            failedTests: test?.failedTests ?? 0,
          },
        };
      },
    },

    // ── SHIP ──────────────────────────────────────────────────────────────────
    // HITL checkpoint fires here when plan.requiresCeoApproval === true
    ship: {
      agent: shipAgent,
      dependsOn: ["verify"] as const,
      hitl: {
        mode: "permissions",
        tools: [],
      },
      input: (ctx: unknown) => {
        type Ctx = CtxFor<WorkflowTasks, "ship">;
        const typed = ctx as unknown as Ctx;

        const plan = typed.plan.output;
        const loopOut = typed.buildLoop.output as Record<
          string,
          { output: unknown }
        >;
        const build = loopOut.build?.output as BuildOutput | undefined;
        const verify = typed.verify.output;

        return {
          issueNumber: 42,
          issueTitle: plan.summary,
          patch: build?.patch ?? "",
          filesChanged: build?.filesChanged ?? [],
          explanation: build?.explanation ?? "",
          reviewSummary: verify.summary,
          branchName: "fix/issue-42-task-metrics",
          repoPath: ".",
        };
      },
    },
  },
});
