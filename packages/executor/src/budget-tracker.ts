import type { BudgetConfig, BudgetExceededInfo } from "@ageflow/core";
import { BudgetExceededError } from "@ageflow/core";

/** Model pricing (USD per 1M tokens). Update when Anthropic/OpenAI change prices. */
const MODEL_PRICES: Record<
  string,
  { inputPerMToken: number; outputPerMToken: number }
> = {
  "claude-opus-4-6": { inputPerMToken: 15.0, outputPerMToken: 75.0 },
  "claude-sonnet-4-6": { inputPerMToken: 3.0, outputPerMToken: 15.0 },
  "claude-haiku-4-5": { inputPerMToken: 0.8, outputPerMToken: 4.0 },
  // codex models
  "o4-mini": { inputPerMToken: 1.1, outputPerMToken: 4.4 },
  o3: { inputPerMToken: 10.0, outputPerMToken: 40.0 },
  // fallback
  _default: { inputPerMToken: 3.0, outputPerMToken: 15.0 },
};

export class BudgetTracker {
  private totalCost = 0;
  private _exceededNotified = false;

  costFor(model: string, tokensIn: number, tokensOut: number): number {
    const prices =
      MODEL_PRICES[model] ??
      (MODEL_PRICES._default as {
        inputPerMToken: number;
        outputPerMToken: number;
      });
    return (
      (tokensIn / 1_000_000) * prices.inputPerMToken +
      (tokensOut / 1_000_000) * prices.outputPerMToken
    );
  }

  addCost(model: string, tokensIn: number, tokensOut: number): void {
    this.totalCost += this.costFor(model, tokensIn, tokensOut);
  }

  get total(): number {
    return this.totalCost;
  }

  /** Alias for total — semantic clarity when reading as "current spend". */
  get currentCost(): number {
    return this.totalCost;
  }

  checkBudget(config: BudgetConfig): void {
    if (config.onExceed === "halt" && this.totalCost > config.maxCost) {
      throw new BudgetExceededError(config.maxCost, this.totalCost);
    }
    // onExceed: "warn" — caller handles warning, no throw
  }

  exceeded(config: BudgetConfig): boolean {
    return this.totalCost > config.maxCost;
  }

  /**
   * If the budget is exceeded and `config.onExceeded` is defined, calls the
   * callback with current spend info. Errors thrown by the callback are caught
   * and logged as warnings — they never crash the workflow.
   */
  async fireOnExceeded(
    config: BudgetConfig,
    taskName: string,
    workflowName: string,
  ): Promise<void> {
    if (!config.onExceeded) return;
    if (!this.exceeded(config)) return;
    if (this._exceededNotified) return;
    this._exceededNotified = true;

    const info: BudgetExceededInfo = {
      currentCostUsd: this.totalCost,
      maxCostUsd: config.maxCost,
      taskName,
      workflowName,
    };

    try {
      await config.onExceeded(info);
    } catch (err) {
      console.warn("[AgentFlow] onExceeded callback error", { taskName }, err);
    }
  }
}
