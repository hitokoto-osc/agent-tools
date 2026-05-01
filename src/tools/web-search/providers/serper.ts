import { z } from "zod";
import { SearchProviderError, type SearchBackend, type SearchHit } from "../types.js";

export const serperQueryItemSchema = z.object({
  q: z.string().min(1),
  gl: z.string().optional(),
  hl: z.string().optional(),
  tbs: z.string().optional(),
  page: z.number().int().positive().optional(),
  num: z.number().int().min(1).max(20).optional(),
});
export type SerperQueryItem = z.infer<typeof serperQueryItemSchema>;

const sitelinkSchema = z.object({ title: z.string(), link: z.string() }).passthrough();
const organicResultSchema = z
  .object({
    title: z.string(),
    link: z.string(),
    snippet: z.string().optional(),
    date: z.string().optional(),
    position: z.number().optional(),
    sitelinks: z.array(sitelinkSchema).optional(),
  })
  .passthrough();

export const serperResponseSchema = z
  .object({
    searchParameters: z.unknown().optional(),
    knowledgeGraph: z.unknown().optional(),
    organic: z.array(organicResultSchema).optional(),
    peopleAlsoAsk: z.array(z.unknown()).optional(),
    relatedSearches: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type SerperResponse = z.infer<typeof serperResponseSchema>;

export const serperResponseListSchema = z.union([
  z.array(serperResponseSchema),
  serperResponseSchema,
]);

export interface SerperOptions {
  apiKey?: string;
  baseURL?: string;
  gl?: string;
  hl?: string;
  tbs?: string;
  page?: number;
  timeoutMs?: number;
}

export type SerperBatchFn = (
  items: SerperQueryItem[],
  options?: { signal?: AbortSignal },
) => Promise<SearchHit[][]>;

export type SerperBackend = SearchBackend & { batch: SerperBatchFn };

const DEFAULT_BASE_URL = "https://google.serper.dev";
const DEFAULT_TIMEOUT_MS = 30_000;

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function clampTopK(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(20, Math.max(1, Math.floor(value)));
}

function endpointFor(baseURL: string): URL {
  const base = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  return new URL("search", base);
}

function buildItem(base: SerperOptions, q: string, topK: number | undefined): SerperQueryItem {
  const item = {
    q,
    ...(base.gl !== undefined ? { gl: base.gl } : {}),
    ...(base.hl !== undefined ? { hl: base.hl } : {}),
    ...(base.tbs !== undefined ? { tbs: base.tbs } : {}),
    ...(base.page !== undefined ? { page: base.page } : {}),
    ...(topK !== undefined ? { num: clampTopK(topK) } : {}),
  };
  return serperQueryItemSchema.parse(item);
}

function mergeItem(base: SerperOptions, override: SerperQueryItem): SerperQueryItem {
  const item = {
    q: override.q,
    ...(override.gl !== undefined
      ? { gl: override.gl }
      : base.gl !== undefined
        ? { gl: base.gl }
        : {}),
    ...(override.hl !== undefined
      ? { hl: override.hl }
      : base.hl !== undefined
        ? { hl: base.hl }
        : {}),
    ...(override.tbs !== undefined
      ? { tbs: override.tbs }
      : base.tbs !== undefined
        ? { tbs: base.tbs }
        : {}),
    ...(override.page !== undefined
      ? { page: override.page }
      : base.page !== undefined
        ? { page: base.page }
        : {}),
    ...(override.num !== undefined ? { num: clampTopK(override.num) } : {}),
  };
  return serperQueryItemSchema.parse(item);
}

function organicToHits(parsed: SerperResponse): SearchHit[] {
  return (parsed.organic ?? []).map((organic) => {
    const hit: SearchHit = { title: organic.title, url: organic.link, source: "serper" };
    if (organic.snippet) hit.snippet = organic.snippet;
    if (organic.date) hit.date = organic.date;
    if (typeof organic.position === "number") hit.position = organic.position;
    return hit;
  });
}

async function postSearch(
  baseURL: string,
  apiKey: string,
  body: SerperQueryItem[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<SerperResponse[]> {
  const requestSignal =
    signal !== undefined
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
  const endpoint = endpointFor(baseURL);

  let response: Response;
  try {
    response = await globalThis.fetch(endpoint, {
      method: "POST",
      signal: requestSignal,
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SearchProviderError(`Serper request failed: ${message}`, {
      provider: "serper",
      code: "network_error",
      cause,
    });
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    throw new SearchProviderError(`Serper responded ${response.status} ${response.statusText}`, {
      provider: "serper",
      status: response.status,
      ...(retryAfter !== null ? { retryAfter } : {}),
    });
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new SearchProviderError("Serper returned non-JSON body", {
      provider: "serper",
      code: "invalid_response",
      cause,
    });
  }

  const parsed = serperResponseListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SearchProviderError("Serper response failed schema validation", {
      provider: "serper",
      code: "invalid_response",
      cause: parsed.error,
    });
  }
  if (body.length > 1 && !Array.isArray(parsed.data)) {
    throw new SearchProviderError("Serper returned a non-array response for a batch request", {
      provider: "serper",
      code: "invalid_response",
    });
  }
  const responses = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  if (body.length > 1 && responses.length !== body.length) {
    throw new SearchProviderError("Serper batch response length did not match request length", {
      provider: "serper",
      code: "invalid_response",
    });
  }
  return responses;
}

export function serper(options: SerperOptions = {}): SerperBackend {
  const timeoutMs = resolvePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;

  const resolveKey = (): string => {
    const apiKey = options.apiKey ?? process.env["SERPER_API_KEY"];
    if (!apiKey) {
      throw new SearchProviderError("Missing Serper API key. Pass apiKey or set SERPER_API_KEY.", {
        provider: "serper",
        code: "missing_api_key",
      });
    }
    return apiKey;
  };

  const single: SearchBackend = async ({ query, topK, signal }) => {
    const item = buildItem(options, query, topK);
    const responses = await postSearch(baseURL, resolveKey(), [item], timeoutMs, signal);
    const first = responses[0];
    return first ? organicToHits(first) : [];
  };

  const batch: SerperBatchFn = async (items, opts) => {
    if (items.length === 0) return [];
    const body = items.map((item) => mergeItem(options, item));
    const responses = await postSearch(baseURL, resolveKey(), body, timeoutMs, opts?.signal);
    return body.map((_, index) => {
      const response = responses[index];
      return response ? organicToHits(response) : [];
    });
  };

  return Object.assign(single, { batch });
}
