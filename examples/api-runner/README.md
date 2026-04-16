# api-runner example

Minimal workflow showing `@ageflow/runner-api` calling any OpenAI-compatible
endpoint to summarize a text string.

## Running the demo

### With a real endpoint

```bash
OPENAI_API_KEY=<your-key> bun run demo
# or point at a local model:
OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=ollama bun run demo
```

### Offline (mock fetch — no credentials needed)

```bash
AGENTFLOW_MOCK=1 bun run demo
```

## Running tests

```bash
bun run test
```

Uses `@ageflow/testing` harness — no real API calls.

## Provider table

| Provider     | OPENAI_BASE_URL                                                     |
|--------------|---------------------------------------------------------------------|
| OpenAI       | `https://api.openai.com/v1`                                         |
| Groq         | `https://api.groq.com/openai/v1`                                    |
| Together AI  | `https://api.together.xyz/v1`                                       |
| Ollama       | `http://localhost:11434/v1`                                         |
| vLLM         | `http://localhost:8000/v1`                                          |
| LM Studio    | `http://localhost:1234/v1`                                          |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<model>`   |

## Files

```
examples/api-runner/
├── agents/
│   └── summarize.ts       — defineAgent using runner: "api"
├── __mocks__/
│   └── fetch-mock.ts      — offline canned response
├── workflow.ts            — registerRunner + defineWorkflow
├── workflow.test.ts       — harness test (no real calls)
└── README.md
```
