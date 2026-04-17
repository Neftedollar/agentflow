/**
 * fetch-mock.ts — Offline fetch stub for the api-runner example.
 *
 * Returns a canned OpenAI-compatible ChatCompletionResponse so the demo
 * can run without credentials.  Inject via:
 *
 *   AGENTFLOW_MOCK=1 bun run demo
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
            summary:
              "AgentFlow ships an HTTP runner that talks to any OpenAI-compatible endpoint.",
          }),
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 42,
      completion_tokens: 18,
      total_tokens: 60,
    },
  });

  return Promise.resolve(
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}
