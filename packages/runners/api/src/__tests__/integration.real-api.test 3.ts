import { describe, expect, it } from "vitest";
import { ApiRunner } from "../api-runner.js";

const RUN_INTEGRATION = process.env.AGEFLOW_INTEGRATION === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

describeIntegration("real OpenAI API integration", () => {
  it("sends a prompt and receives a valid response", async () => {
    const runner = new ApiRunner({
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      // biome-ignore lint/style/noNonNullAssertion: OPENAI_API_KEY is required when AGEFLOW_INTEGRATION=1
      apiKey: process.env.OPENAI_API_KEY!,
      defaultModel: "gpt-4o-mini",
    });

    const result = await runner.spawn({
      prompt: "Reply with exactly the word 'hello' and nothing else.",
      model: "gpt-4o-mini",
    });

    expect(result.stdout.toLowerCase()).toContain("hello");
    expect(result.tokensIn).toBeGreaterThan(0);
    expect(result.tokensOut).toBeGreaterThan(0);
  }, 30_000); // 30s timeout for real API
});
