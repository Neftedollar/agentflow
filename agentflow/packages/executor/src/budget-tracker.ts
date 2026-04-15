import type { BudgetConfig } from "@agentflow/core";
import { BudgetExceededError } from "@agentflow/core";

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

  checkBudget(config: BudgetConfig): void {
    if (config.onExceed === "halt" && this.totalCost > config.maxCost) {
      throw new BudgetExceededError(config.maxCost, this.totalCost);
    }
    // onExceed: "warn" — caller handles warning, no throw
  }

  exceeded(config: BudgetConfig): boolean {
    return this.totalCost > config.maxCost;
  }
}
