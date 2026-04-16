import { describe, expect, it } from "vitest";
import { ApiRunner } from "../api-runner.js";

const url = process.env.AGENTFLOW_TEST_API_URL;
const key = process.env.AGENTFLOW_TEST_API_KEY;
const model = process.env.AGENTFLOW_TEST_API_MODEL ?? "gpt-4o-mini";

const maybe = url && key ? describe : describe.skip;

maybe("ApiRunner (live)", () => {
  it("completes a trivial prompt", async () => {
    const runner = new ApiRunner({
      baseUrl: url as string,
      apiKey: key as string,
      defaultModel: model,
    });
    const res = await runner.spawn({
      prompt: "Reply with the single word: pong",
    });
    expect(res.stdout.toLowerCase()).toContain("pong");
    expect(res.tokensIn).toBeGreaterThan(0);
    expect(res.tokensOut).toBeGreaterThan(0);
  }, 30_000);
});
