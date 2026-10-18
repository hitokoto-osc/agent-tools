import { z } from "zod";
import { SearchProviderError, type SearchBackend, type SearchHit } from "../types.js";

/**
 * DeepSeek Search API (`POST /v1/tools/search`).
 * Docs: https://api-docs.deepseek.com/guides/search/
 *
 * Billed per successful request ($0.75 / 1k); empty `results` arrays and
 * failed requests are not billed. Account-level QPS limit: 5.
 */
export const deepseekRequestSchema = z.object({
  query: z.string().trim().min(1).max(128),
  count: z.number().int().min(1).max(50),
  need_content: z.boolean(),
});
export type DeepSeekRequest = z.infer<typeof deepseekRequestSchema>;

export const deepseekResultSchema = z
  .object({
    rerank_score: z.number(),
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    summary: z.string(),
    content: z.string(),
    site_name: z.string().nullable(),
    site_icon: z.string().nullable(),
    date: z.string().nullable(),
    authority: z.number().int(),
  })
  .passthrough();
export type DeepSeekResult = z.infer<typeof deepseekResultSchema>;

export const deepseekResponseSchema = z
  .object({ results: z.array(deepseekResultSchema) })
  .passthrough();
export type DeepSeekResponse = z.infer<typeof deepseekResponseSchema>;

const deepseekErrorSchema = z
  .object({ error: z.object({ message: z.string() }).passthrough() })
  .passthrough();

export interface DeepSeekOptions {
  /** Falls back to the `DEEPSEEK_API_KEY` env var, resolved lazily at call time. */
  apiKey?: string;
  /** Default `https://api.deepseek.com/v1`. */
  baseURL?: string;
  timeoutMs?: number;
  /** Return full page content per hit. Default false (keeps responses light). */
  needContent?: boolean;
  /**
   * Which DeepSeek field maps to `SearchHit.snippet`. `summary` (default) is
   * the 600-800 char model-oriented abstract; `snippet` is the 100-200 char
   * display blurb. Falls back to the other field when the chosen one is empty.
   */
  snippetSource?: "summary" | "snippet";
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function clampTopK(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(50, Math.max(1, Math.floor(value)));
}

function endpointFor(baseURL: string): URL {
  const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  return new URL("tools/search", base);
}

function resultToHit(
  result: DeepSeekResult,
  index: number,
  snippetSource: "summary" | "snippet",
): SearchHit {
  const primary = snippetSource === "summary" ? result.summary : result.snippet;
  const secondary = snippetSource === "summary" ? result.snippet : result.summary;
  const hit: SearchHit = {
    title: result.title,
    url: result.url,
    position: index + 1,
    score: result.rerank_score,
    source: "deepseek",
  };
  const text = primary || secondary;
  if (text) hit.snippet = text;
  if (result.date) hit.date = result.date;
  // authority tier -1 means "unknown" — omit it rather than report a bogus tier.
  if (result.authority >= 0) hit.authority = result.authority;
  return hit;
}

export function deepseek(options: DeepSeekOptions = {}): SearchBackend {
  const timeoutMs = resolvePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const needContent = options.needContent ?? false;
  const snippetSource = options.snippetSource ?? "summary";

  const resolveKey = (): string => {
    const apiKey = options.apiKey ?? process.env["DEEPSEEK_API_KEY"];
    if (!apiKey) {
      throw new SearchProviderError(
        "Missing DeepSeek API key. Pass apiKey or set DEEPSEEK_API_KEY.",
        { provider: "deepseek", code: "missing_api_key" },
      );
    }
    return apiKey;
  };

  return async ({ query, topK, signal }) => {
    const body = deepseekRequestSchema.parse({
      query,
      count: clampTopK(topK),
      need_content: needContent,
    });
    const apiKey = resolveKey();

    const requestSignal =
      signal !== undefined
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await globalThis.fetch(endpointFor(baseURL), {
        method: "POST",
        signal: requestSignal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SearchProviderError(`DeepSeek search request failed: ${message}`, {
        provider: "deepseek",
        code: "network_error",
        cause,
      });
    }

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      let detail = response.statusText;
      try {
        const parsed = deepseekErrorSchema.safeParse(await response.json());
        if (parsed.success) detail = parsed.data.error.message;
      } catch {
        // non-JSON error body — fall back to statusText
      }
      throw new SearchProviderError(`DeepSeek search responded ${response.status}: ${detail}`, {
        provider: "deepseek",
        status: response.status,
        ...(retryAfter !== null ? { retryAfter } : {}),
      });
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (cause) {
      throw new SearchProviderError("DeepSeek search returned non-JSON body", {
        provider: "deepseek",
        code: "invalid_response",
        cause,
      });
    }

    const parsed = deepseekResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SearchProviderError("DeepSeek search response failed schema validation", {
        provider: "deepseek",
        code: "invalid_response",
        cause: parsed.error,
      });
    }

    return parsed.data.results.map((result, index) => resultToHit(result, index, snippetSource));
  };
}
