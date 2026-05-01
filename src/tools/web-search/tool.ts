import { generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { defaultModel } from "../../model.js";
import type { SearchBackend, SearchHit } from "./types.js";

const webSearchHitSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string().optional(),
  position: z.number().optional(),
  date: z.string().optional(),
  source: z.string().optional(),
});

export const webSearchInputSchema = z.object({
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

export const webSearchOutputSchema = z.object({
  query: z.string(),
  refinedQuery: z.string(),
  hits: z.array(webSearchHitSchema),
  synthesis: z.string(),
});

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export type WebSearchResult = z.infer<typeof webSearchOutputSchema>;

export interface WebSearchOptions {
  /** Backend that performs the actual HTTP search. Required. */
  backend: SearchBackend;
  /** Override the LLM used for query refinement and synthesis. Defaults to `defaultModel()`. */
  model?: LanguageModel;
  /**
   * Base URL of the OpenAI-compatible endpoint used for model calls.
   * Falls back to `OPENAI_BASE_URL` or `OPENAI_API_BASE` env, then `https://api.openai.com/v1`.
   * Ignored when `model` is supplied.
   */
  baseURL?: string;
  /** API key for model calls. Falls back to `OPENAI_API_KEY` env. Ignored when `model` is supplied. */
  apiKey?: string;
  /**
   * Model id for model calls.
   * Falls back to `AGENT_TOOLS_MODEL` env. Ignored when `model` is supplied.
   */
  modelId?: string;
  /** Extra HTTP headers forwarded to the model endpoint. Ignored when `model` is supplied. */
  headers?: Record<string, string>;
  /**
   * Extra query parameters appended to every model request URL
   * (e.g. Azure OpenAI `api-version`). Ignored when `model` is supplied.
   */
  queryParams?: Record<string, string>;
  /** Default top_k passed to the backend when the caller does not specify one. */
  defaultTopK?: number;
  /** Allow the LLM to reformulate the query before calling the backend. Default true. */
  refineQuery?: boolean;
}

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

async function refine(
  model: LanguageModel,
  query: string,
  intent: string | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const { text } = await generateText({
    model,
    maxOutputTokens: 80,
    system:
      "Rewrite the user query into the most effective single web-search query. " +
      "Output ONLY the rewritten query, no quotes, no explanation.",
    prompt: intent ? `Intent: ${intent}\nOriginal query: ${query}` : `Original query: ${query}`,
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });
  const refined = text.trim().split("\n")[0]?.trim();
  return refined && refined.length > 0 ? refined : query;
}

async function synthesise(
  model: LanguageModel,
  query: string,
  hits: SearchHit[],
  abortSignal: AbortSignal | undefined,
): Promise<string> {
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
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });
  return text;
}

/**
 * `webSearch` refines the query, calls a caller-supplied backend, then asks
 * the LLM to synthesise findings with inline citations.
 */
export function webSearch(options: WebSearchOptions) {
  const { backend, refineQuery = true } = options;
  const defaultTopK = resolvePositiveInteger(options.defaultTopK, 5);
  const resolveModel = (): LanguageModel =>
    options.model ??
    defaultModel({
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      ...(options.queryParams !== undefined ? { queryParams: options.queryParams } : {}),
    });

  return tool({
    description:
      "Search the web for up-to-date information. Returns ranked hits plus an " +
      "LLM synthesis with inline citations [n].",
    inputSchema: webSearchInputSchema,
    outputSchema: webSearchOutputSchema,
    execute: async ({ query, intent, topK }, { abortSignal }): Promise<WebSearchResult> => {
      let model: LanguageModel | undefined;
      const getModel = (): LanguageModel => (model ??= resolveModel());
      const k = topK ?? defaultTopK;
      const refinedQuery = refineQuery
        ? await refine(getModel(), query, intent, abortSignal)
        : query;
      const hits = await backend({
        query: refinedQuery,
        topK: k,
        ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
      });
      const synthesis =
        hits.length === 0
          ? "No results."
          : await synthesise(getModel(), refinedQuery, hits, abortSignal);
      return { query, refinedQuery, hits, synthesis };
    },
  });
}
