# @ageflow/runner-api

OpenAI-compatible HTTP runner for ageflow. Talks to any `/chat/completions` endpoint via `fetch()`. Supports multi-round tool calling internally, pluggable session storage, and returns `ToolCallRecord[]` for observability. Zero external deps.

## Supported providers

| Provider | Base URL |
|----------|----------|
| OpenAI | `https://api.openai.com/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Ollama | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<model>` |

## Usage

```ts
import { ApiRunner } from "@ageflow/runner-api";

const runner = new ApiRunner({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: "gpt-4o-mini",
});

const result = await runner.spawn({
  prompt: "Summarize this document.",
  model: "gpt-4o",
});

console.log(result.stdout);
console.log(result.toolCalls); // ToolCallRecord[] if tools were used
```

## Installation

```bash
bun add @ageflow/runner-api
```
