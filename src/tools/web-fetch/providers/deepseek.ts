import { LRUCache } from "lru-cache";
import { z } from "zod";
import {
  CACHE_TTL_MS,
  FetchProviderError,
  MAX_CACHE_SIZE_BYTES,
  upgradeHttpToHttps,
  validateURL,
  type FetchBackend,
  type FetchedContent,
} from "../fetch.ts";

/**
 * DeepSeek Fetch API (`POST /v1/tools/fetch`) as a `webFetch` fetcher.
 * Docs: https://api-docs.deepseek.com/guides/search/
 *
 * The API returns the page as Markdown, so no turndown pass is needed. Billed
 * per successful request ($0.75 / 1k); failed fetches are not billed. Limits:
 * 5 QPS per account plus a per-domain QPS cap (both surface as HTTP 429).
 */
export const deepseekFetchRequestSchema = z.object({
  url: z.string().max(8192),
});

export const deepseekFetchResponseSchema = z
  .object({
    title: z.string(),
    content: z.string(),
  })
  .passthrough();
export type DeepSeekFetchResponse = z.infer<typeof deepseekFetchResponseSchema>;

const deepseekErrorSchema = z
  .object({ error: z.object({ message: z.string() }).passthrough() })
  .passthrough();

export interface DeepSeekFetchOptions {
  /** Falls back to the `DEEPSEEK_API_KEY` env var, resolved lazily at call time. */
  apiKey?: string;
  /** Default `https://api.deepseek.com/v1`. */
  baseURL?: string;
  timeoutMs?: number;
  /** Cache successful fetches (15 min TTL, same policy as the default fetcher). Default true. */
  cache?: boolean;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

const URL_CACHE = new LRUCache<string, FetchedContent>({
  max: 200,
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
  sizeCalculation: (entry) => Math.max(1, Buffer.byteLength(entry.content)),
});

export function clearDeepSeekFetchCache(): void {
  URL_CACHE.clear();
}

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function endpointFor(baseURL: string): URL {
  const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  return new URL("tools/fetch", base);
}

export function deepseekFetch(options: DeepSeekFetchOptions = {}): FetchBackend {
  const timeoutMs = resolvePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const useCache = options.cache ?? true;

  const resolveKey = (): string => {
    const apiKey = options.apiKey ?? process.env["DEEPSEEK_API_KEY"];
    if (!apiKey) {
      throw new FetchProviderError(
        "Missing DeepSeek API key. Pass apiKey or set DEEPSEEK_API_KEY.",
        { provider: "deepseek", code: "missing_api_key" },
      );
    }
    return apiKey;
  };

  return async (url, { signal }) => {
    // DeepSeek validates the URL server-side too (http/https, no credentials,
    // <= 8192 chars); validateURL is stricter on host shape but that is fine.
    validateURL(url);
    const cacheKey = upgradeHttpToHttps(url);
    if (useCache) {
      const cachedEntry = URL_CACHE.get(cacheKey);
      if (cachedEntry) return cachedEntry;
    }

    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const apiKey = resolveKey();

    let response: Response;
    try {
      response = await globalThis.fetch(endpointFor(baseURL), {
        method: "POST",
        signal: requestSignal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ url: cacheKey }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new FetchProviderError(`DeepSeek fetch request failed: ${message}`, {
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
      throw new FetchProviderError(`DeepSeek fetch responded ${response.status}: ${detail}`, {
        provider: "deepseek",
        status: response.status,
        ...(retryAfter !== null ? { retryAfter } : {}),
      });
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (cause) {
      throw new FetchProviderError("DeepSeek fetch returned non-JSON body", {
        provider: "deepseek",
        code: "invalid_response",
        cause,
      });
    }

    const parsed = deepseekFetchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FetchProviderError("DeepSeek fetch response failed schema validation", {
        provider: "deepseek",
        code: "invalid_response",
        cause: parsed.error,
      });
    }

    const entry: FetchedContent = {
      bytes: Buffer.byteLength(parsed.data.content),
      code: 200,
      codeText: "OK",
      content: parsed.data.content,
      contentType: "text/markdown",
      isBinary: false,
      url: cacheKey,
    };

    if (useCache) URL_CACHE.set(cacheKey, entry);
    return entry;
  };
}
