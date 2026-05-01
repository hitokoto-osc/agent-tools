# agent-tools

Model-driven agent tools (web fetch, web search, …) built on the [Vercel AI SDK](https://ai-sdk.dev). Each tool is a `tool({ inputSchema, outputSchema, execute })` factory, so the same code is consumable from any AI SDK `generateText` / `streamText` call, from a custom agent loop, or from an MCP server.

## Features

- **`webFetch`** — downloads a URL, converts HTML to Markdown via `turndown`, then runs a caller-supplied prompt against the content with a secondary LLM. Includes redirect handling, binary detection, an LRU cache (15 min TTL), and a pre-approved-host short-circuit that returns raw Markdown without an extra LLM call.
- **`webSearch`** — refines the user query with the LLM, calls a pluggable backend (`serper` is bundled), and returns ranked hits plus a synthesis with inline `[n]` citations.
- **OpenAI-compatible by default** — any provider exposing the OpenAI Chat Completions API works (OpenAI, DeepSeek, Azure OpenAI, OpenRouter, local llama.cpp/Ollama proxies, …). Swap in your own `LanguageModel` to use a different SDK.
- **Strict I/O contracts** — every tool ships `zod` `inputSchema` / `outputSchema` so the schemas can be exposed verbatim through MCP or function-calling APIs.
- **Lazy model resolution** — tools never construct a model client until `execute` runs, so you can list schemas (e.g. for MCP `tools/list`) without an API key set.

## Install

```bash
pnpm add agent-tools
# or
npm install agent-tools
```

Requires Node.js `>= 20.3`.

## Quick start

```ts
import { generateText } from "ai";
import { AgentTools, serper } from "agent-tools";

const tools = new AgentTools(); // uses OPENAI_API_KEY + AGENT_TOOLS_MODEL env vars

const result = await generateText({
  model: tools.model,
  prompt: "Summarise the latest Vercel AI SDK release notes.",
  tools: {
    webFetch: tools.webFetch(),
    webSearch: tools.webSearch({ backend: serper() }),
  },
});

console.log(result.text);
```

### Environment variables

| Variable                              | Purpose                                                           | Default                                           |
| ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `OPENAI_API_KEY`                      | API key forwarded to the model endpoint.                          | — (required when no explicit `apiKey` is passed)  |
| `OPENAI_BASE_URL` / `OPENAI_API_BASE` | Base URL of the OpenAI-compatible endpoint.                       | `https://api.openai.com/v1`                       |
| `AGENT_TOOLS_MODEL`                   | Default model id used for summarisation / refinement / synthesis. | `gpt-4o-mini`                                     |
| `SERPER_API_KEY`                      | API key for the bundled `serper()` backend.                       | — (required when using `serper` without `apiKey`) |

## Using individual tools

If you do not want the `AgentTools` wrapper, import the factories directly:

```ts
import { generateText } from "ai";
import { webFetch, webSearch, serper, createProvider } from "agent-tools";

const provider = createProvider({ baseURL: "https://api.deepseek.com/v1" });
const model = provider("deepseek-chat");

await generateText({
  model,
  prompt: "What changed in React 19?",
  tools: {
    webFetch: webFetch({ model }),
    webSearch: webSearch({ model, backend: serper({ gl: "us", hl: "en" }) }),
  },
});
```

### `webFetch` options

```ts
webFetch({
  model, // optional LanguageModel; falls back to defaultModel()
  baseURL,
  apiKey, // forwarded to defaultModel() when `model` is omitted
  modelId,
  headers,
  queryParams,
  maxContentBytes, // raw download cap, default 10 MiB
  maxMarkdownChars, // Markdown cap fed into the summariser, default 100_000
  maxOutputTokens, // optional cap on summariser output
  userAgent, // default User-Agent header
  timeoutMs, // request timeout, default 60_000 ms
});
```

Behaviour highlights:

- HTTP URLs are upgraded to HTTPS.
- Cross-host redirects return a structured "REDIRECT DETECTED" payload so the calling agent can re-issue the request with the new URL.
- Binary responses bypass the LLM and return content directly.
- Pre-approved hosts (e.g. canonical documentation domains) short-circuit when the body is already Markdown and small enough.

### `webSearch` options

```ts
webSearch({
  backend: serper(), // required — any function matching SearchBackend works
  model, // optional LanguageModel
  defaultTopK, // hits per call when caller omits topK, default 5
  refineQuery, // set false to skip query rewriting, default true
});
```

Returned object:

```ts
{
  query: string; // original query
  refinedQuery: string; // LLM-rewritten query actually sent to the backend
  hits: Array<{ title; url; snippet?; position?; date?; source? }>;
  synthesis: string; // grounded summary with [n] citations
}
```

### Bundled backend: Serper

```ts
import { serper } from "agent-tools";

const backend = serper({
  apiKey: process.env.SERPER_API_KEY,
  gl: "us", // country
  hl: "en", // language
  timeoutMs: 30_000,
});

// Single query
const hits = await backend({ query: "vercel ai sdk", topK: 5 });

// Mini-batch (Serper supports up to N queries per HTTP call)
const batched = await backend.batch([
  { q: "vercel ai sdk" },
  { q: "openai responses api", num: 10 },
]);
```

### Custom backends

Implement the `SearchBackend` interface to plug in any provider (Bing, Brave, Tavily, internal index, …):

```ts
import type { SearchBackend, SearchHit } from "agent-tools";

const myBackend: SearchBackend = async ({ query, topK, signal }) => {
  const res = await fetch(`https://example.com/search?q=${encodeURIComponent(query)}`, { signal });
  const json = await res.json();
  return json.results.slice(0, topK).map<SearchHit>((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.summary,
    source: "example",
  }));
};
```

## Exposing the tools over MCP

Because every tool is a plain AI SDK `Tool` with `inputSchema` / `outputSchema`, it can be wrapped by any MCP server adapter that understands the AI SDK tool shape — no transformation required.

## Development

```bash
pnpm install
pnpm test                 # node:test, no network
pnpm test:integration     # real-network tests, needs OPENAI_API_KEY / SERPER_API_KEY
pnpm check                # lint + format-check + typecheck + build
pnpm build                # bundle to dist/
```

## License

MIT
