/**
 * fetch-mock.ts — Offline fetch stub for the agent-uses-mcp api-runner demo.
 *
 * Returns a canned OpenAI-compatible ChatCompletionResponse so the demo
 * can run without credentials. Inject via:
 *
 *   AGENTFLOW_MOCK=1 bun workflow.ts --runner api
 */

export function mockFetch(
  _url: string | URL | Request,
  _init?: RequestInit,
): Promise<Response> {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify({
            summary: "Found 3 files in .",
            fileCount: 3,
          }),
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 55,
      completion_tokens: 22,
      total_tokens: 77,
    },
  });

  return Promise.resolve(
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}
