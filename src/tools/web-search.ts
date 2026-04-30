import { generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { defaultModel } from "../model.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Pluggable backend that returns raw search hits. Decoupled from the model
 * layer so callers can wire in any provider (Tavily, Brave, SerpAPI, an
 * internal index, etc.).
 */
export type SearchBackend = (args: {
  query: string;
  topK: number;
  signal?: AbortSignal;
}) => Promise<SearchHit[]>;

export interface WebSearchOptions {
  /** Backend that performs the actual HTTP search. Required. */
  backend: SearchBackend;
  /** LLM used to refine queries and synthesise findings. */
  model?: LanguageModel;
  /** Default top_k passed to the backend when the caller does not specify one. */
  defaultTopK?: number;
  /** Allow the LLM to reformulate the query before calling the backend. Default true. */
  refineQuery?: boolean;
}

const inputSchema = z.object({
  query: z.string().min(1).describe("Natural-language search query."),
  intent: z
    .string()
    .optional()
    .describe(
      "Optional one-line description of why the caller wants this. Improves query refinement.",
    ),
  topK: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Number of hits to retrieve from the backend."),
});

export interface WebSearchResult {
  query: string;
  refinedQuery: string;
  hits: SearchHit[];
  synthesis: string;
}

async function refine(
  model: LanguageModel,
  query: string,
  intent: string | undefined,
): Promise<string> {
  const { text } = await generateText({
    model,
    maxOutputTokens: 80,
    system:
      "Rewrite the user query into the most effective single web-search query. " +
      "Output ONLY the rewritten query, no quotes, no explanation.",
    prompt: intent ? `Intent: ${intent}\nOriginal query: ${query}` : `Original query: ${query}`,
  });
  const refined = text.trim().split("\n")[0]?.trim();
  return refined && refined.length > 0 ? refined : query;
}

async function synthesise(model: LanguageModel, query: string, hits: SearchHit[]): Promise<string> {
  if (hits.length === 0) return "No results.";
  const corpus = hits
    .map((h, i) => `[${i + 1}] ${h.title}\n    ${h.url}\n    ${h.snippet ?? ""}`)
    .join("\n");
  const { text } = await generateText({
    model,
    maxOutputTokens: 600,
    system:
      "Synthesise concrete findings from search results for an autonomous agent. " +
      "Cite sources by their bracket number, e.g. [2]. Do not invent facts.",
    prompt: `Query: ${query}\n\nResults:\n${corpus}`,
  });
  return text;
}

/**
 * `webSearch` — model-driven search tool. Refines the query, calls the
 * caller-supplied backend, then asks the LLM to synthesise findings with
 * inline citations.
 */
export function webSearch(options: WebSearchOptions) {
  const { backend, model = defaultModel(), defaultTopK = 5, refineQuery = true } = options;

  return tool({
    description:
      "Search the web for up-to-date information. Returns ranked hits plus an " +
      "LLM synthesis with inline citations [n].",
    inputSchema,
    execute: async ({ query, intent, topK }): Promise<WebSearchResult> => {
      const k = topK ?? defaultTopK;
      const refinedQuery = refineQuery ? await refine(model, query, intent) : query;
      const hits = await backend({ query: refinedQuery, topK: k });
      const synthesis = await synthesise(model, refinedQuery, hits);
      return { query, refinedQuery, hits, synthesis };
    },
  });
}
