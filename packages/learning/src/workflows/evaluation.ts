import { defineAgent, defineWorkflow } from "@ageflow/core";
import type { BoundCtx } from "@ageflow/core";
import { WorkflowExecutor } from "@ageflow/executor";
import { z } from "zod";
import { computeDownstream } from "../dag-utils.js";
import type { SkillStore, TraceStore } from "../interfaces.js";
import type { ExecutionTrace, SkillRecord, TraceFilter } from "../types.js";
import { DEFAULT_THRESHOLDS } from "../types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Number of recent traces to sample for evaluation. */
const DEFAULT_TRACE_SAMPLE = 10;

// ─── Evaluation output schema ─────────────────────────────────────────────────

export const HypotheticalVerdictSchema = z.object({
  wouldHaveImproved: z.boolean(),
  confidenceScore: z.number().min(0).max(1),
  reasoning: z.string(),
  estimatedScoreDelta: z.number().min(-1).max(1),
});

export type HypotheticalVerdict = z.infer<typeof HypotheticalVerdictSchema>;

// ─── Input schema ─────────────────────────────────────────────────────────────

const HypotheticalComparisonInputSchema = z.object({
  taskInput: z.string(), // JSON-serialized historical task input
  actualOutput: z.string(), // JSON-serialized actual task output
  originalPrompt: z.string(), // original agent prompt (without skill)
  draftSkillContent: z.string(), // proposed skill markdown content
  downstreamResults: z.string(), // JSON-serialized downstream task results
  workflowName: z.string(),
  taskName: z.string(),
});

// ─── Agent: hypotheticalComparisonAgent ──────────────────────────────────────

/**
 * LLM agent (opus-tier) that evaluates a draft skill hypothetically.
 *
 * DESIGN RATIONALE:
 *
 * This agent performs counterfactual reasoning: given a historical task run
 * (input + output + downstream results), would the draft skill have improved
 * the outcome if it had been injected into the agent's prompt?
 *
 * It operates with ZERO side effects — no store writes, no execution.
 * Single LLM call, deterministic verdict + reasoning.
 *
 * The agent uses the downstream results as the ultimate signal — a skill that
 * improves the immediate task output but hurts downstream is net negative.
 */
export const hypotheticalComparisonAgent = defineAgent({
  runner: "api",
  model: "claude-opus-4-5",
  input: HypotheticalComparisonInputSchema,
  output: HypotheticalVerdictSchema,
  sanitizeInput: true,
  prompt: ({
    taskInput,
    actualOutput,
    originalPrompt,
    draftSkillContent,
    downstreamResults,
    workflowName,
    taskName,
  }) =>
    `
You are an expert AI systems evaluator performing hypothetical counterfactual analysis.

Your task: determine whether the proposed skill would have improved the outcome of the historical task execution shown below.

## Context
- Workflow: "${workflowName}"
- Task: "${taskName}"

## Historical Task Input
${taskInput}

## Actual Task Output (what happened without the skill)
${actualOutput}

## Original Agent Prompt (without skill injection)
${originalPrompt}

## Proposed Draft Skill Content
This is the skill that would have been injected into the agent's system prompt:

${draftSkillContent}

## Downstream Task Results
These are the results of tasks that depended on the output above. Use these to judge whether the output actually served its purpose.
${downstreamResults}

## Your Evaluation Task

Answer this question: **If the draft skill had been injected into the agent's system prompt, would it have improved the overall outcome?**

### Evaluation Criteria

1. **Relevance**: Is the skill relevant to this task's failure mode? Would the agent have followed its instructions given this specific input?

2. **Output Quality**: Would the skill have caused the agent to produce a better output for this specific input? Cite evidence from the actual output to support your assessment.

3. **Downstream Impact**: Would an improved immediate output have led to better downstream results? Or would upstream issues have negated any improvement?

4. **Generalizability Check**: Is the skill's guidance general enough to apply here, or is it too narrowly focused on a different failure pattern?

5. **No-Harm Test**: Could the skill have hurt performance? (e.g., overly prescriptive instructions constraining a task that was already working well)

### Scoring

- \`wouldHaveImproved\`: true if the skill would have net-positive impact, false otherwise
- \`confidenceScore\`: your confidence in this verdict (0 = pure guess, 1 = certain)
- \`estimatedScoreDelta\`: estimated change in task score if skill were applied (-1 to +1, where 0 = no change)
- \`reasoning\`: precise explanation citing specific evidence from the task input, output, and downstream results

## Output Format
Respond with a JSON object:
{
  "wouldHaveImproved": <boolean>,
  "confidenceScore": <number 0-1>,
  "reasoning": "<precise explanation citing specific evidence>",
  "estimatedScoreDelta": <number -1 to 1>
}
`.trim(),
});

// ─── Evaluation Workflow ──────────────────────────────────────────────────────

export const evaluationWorkflow = defineWorkflow({
  name: "__ageflow_evaluation",
  tasks: {
    hypotheticalComparison: {
      agent: hypotheticalComparisonAgent,
      input: {
        taskInput: "",
        actualOutput: "",
        originalPrompt: "",
        draftSkillContent: "",
        downstreamResults: "",
        workflowName: "",
        taskName: "",
      },
    },
  },
});

// ─── EvaluationResult ─────────────────────────────────────────────────────────

export interface EvaluationResult {
  skillId: string;
  skillName: string;
  targetAgent: string;
  verdicts: HypotheticalVerdict[];
  /** Mean estimatedScoreDelta across all traces evaluated. */
  meanScoreDelta: number;
  /** Fraction of traces where wouldHaveImproved = true. */
  improvedFraction: number;
}

// ─── runEvaluation() ─────────────────────────────────────────────────────────

export interface EvaluationInput {
  skillStore: SkillStore;
  traceStore: TraceStore;
  /**
   * DAG structure for the workflow being evaluated.
   * Maps taskName → direct dependsOn list.
   *
   * When provided, downstream task detection uses proper transitive-closure
   * over the dependency graph (fix for #174).  When omitted, downstream
   * defaults to an empty set (safe: no incorrect cross-branch pollution).
   */
  dagStructure?: Record<string, readonly string[]>;
  /** Only evaluate skills with these statuses. Default: ["active", "retired"] */
  statuses?: Array<"active" | "retired">;
  /** Number of recent traces to sample per skill. Default: 10 */
  traceSample?: number;
  /** Model override for the comparison agent. */
  model?: string;
}

export interface EvaluationSummary {
  skillsEvaluated: number;
  results: EvaluationResult[];
}

/**
 * Run the evaluation workflow for all draft/active skills in the store.
 *
 * Steps:
 *   1. List all skills from store (draft + active).
 *   2. For each skill, fetch recent traces for its target task.
 *   3. Run hypotheticalComparisonAgent for each trace.
 *   4. Update the skill's score based on the aggregate verdict.
 *   5. Return a summary.
 */
export async function runEvaluation(
  input: EvaluationInput,
): Promise<EvaluationSummary> {
  const traceSample = input.traceSample ?? DEFAULT_TRACE_SAMPLE;
  const statuses = input.statuses ?? (["active", "retired"] as const);

  // 1. List all skills
  const allSkills = await input.skillStore.list();
  const targetSkills = allSkills.filter((s) =>
    (statuses as string[]).includes(s.status),
  );

  const results: EvaluationResult[] = [];

  for (const skill of targetSkills) {
    // 2. Fetch recent traces for this skill's target task/workflow
    const filter: TraceFilter = {
      ...(skill.targetWorkflow !== undefined
        ? { workflowName: skill.targetWorkflow }
        : {}),
      limit: traceSample,
    };
    const traces = await input.traceStore.getTraces(filter);

    // Filter to traces that include this skill's target task
    const relevantTraces = traces.filter((trace) =>
      trace.taskTraces.some((tt) => tt.taskName === skill.targetAgent),
    );

    if (relevantTraces.length === 0) {
      results.push({
        skillId: skill.id,
        skillName: skill.name,
        targetAgent: skill.targetAgent,
        verdicts: [],
        meanScoreDelta: 0,
        improvedFraction: 0,
      });
      continue;
    }

    // 3. Run hypothetical comparison for each trace
    const verdicts: HypotheticalVerdict[] = [];

    for (const trace of relevantTraces) {
      const taskTrace = trace.taskTraces.find(
        (tt) => tt.taskName === skill.targetAgent,
      );
      if (!taskTrace) continue;

      // Build downstream results: task traces that transitively depend on this
      // task, computed via DAG closure rather than array index (#174).
      const downstreamNames = input.dagStructure
        ? computeDownstream(input.dagStructure, skill.targetAgent)
        : new Set<string>();
      const downstreamTraces = trace.taskTraces.filter((tt) =>
        downstreamNames.has(tt.taskName),
      );

      const dynamicWorkflow = defineWorkflow({
        name: "__ageflow_evaluation",
        tasks: {
          hypotheticalComparison: {
            agent: {
              ...hypotheticalComparisonAgent,
              ...(input.model ? { model: input.model } : {}),
            },
            input: {
              taskInput: JSON.stringify(trace.workflowInput),
              actualOutput: taskTrace.output,
              originalPrompt: taskTrace.prompt,
              draftSkillContent: skill.content,
              downstreamResults: JSON.stringify(downstreamTraces),
              workflowName: trace.workflowName,
              taskName: taskTrace.taskName,
            },
          },
        },
      });

      const executor = new WorkflowExecutor(dynamicWorkflow);
      const runResult = await executor.run();
      const verdict = runResult.outputs
        .hypotheticalComparison as HypotheticalVerdict;
      verdicts.push(verdict);
    }

    // 4. Aggregate verdicts and update skill score
    const meanScoreDelta =
      verdicts.length > 0
        ? verdicts.reduce((sum, v) => sum + v.estimatedScoreDelta, 0) /
          verdicts.length
        : 0;

    const improvedFraction =
      verdicts.length > 0
        ? verdicts.filter((v) => v.wouldHaveImproved).length / verdicts.length
        : 0;

    // Update the skill's score based on evaluation (clamp to [0,1])
    const newScore = Math.max(
      0,
      Math.min(1, skill.score + meanScoreDelta * 0.5),
    );
    await input.skillStore.save({ ...skill, score: newScore });

    results.push({
      skillId: skill.id,
      skillName: skill.name,
      targetAgent: skill.targetAgent,
      verdicts,
      meanScoreDelta,
      improvedFraction,
    });
  }

  return {
    skillsEvaluated: results.length,
    results,
  };
}
