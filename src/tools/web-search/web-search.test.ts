import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCallOptions } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { ZodError } from "zod";
import { serper } from "./providers/serper.js";
import type { SerperQueryItem } from "./providers/serper.js";
import { webSearch } from "./tool.js";
import { SearchProviderError } from "./types.js";

const originalFetch = globalThis.fetch;
const originalSerperApiKey = process.env["SERPER_API_KEY"];

interface FetchCall {
  url: string;
  init: Parameters<typeof fetch>[1];
}

function restoreSerperApiKey(): void {
  if (originalSerperApiKey === undefined) {
    delete process.env["SERPER_API_KEY"];
  } else {
    process.env["SERPER_API_KEY"] = originalSerperApiKey;
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockFetch(
  handler: (url: string, init: Parameters<typeof fetch>[1]) => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = urlOf(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(
  body: unknown,
  options: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    headers: { "content-type": "application/json", ...options.headers },
  });
}

function callAt(calls: FetchCall[], index: number): FetchCall {
  const call = calls[index];
  if (!call) throw new Error(`Missing fetch call at index ${index}`);
  return call;
}

function requestBody(call: FetchCall): SerperQueryItem[] {
  assert.equal(typeof call.init?.body, "string");
  const body = JSON.parse(call.init.body) as unknown;
  assert.ok(Array.isArray(body));
  return body as SerperQueryItem[];
}

function assertProviderError(
  error: unknown,
  expected: { code?: string; status?: number; retryAfter?: string },
): true {
  assert.ok(error instanceof SearchProviderError);
  assert.equal(error.provider, "serper");
  if ("code" in expected) assert.equal(error.code, expected.code);
  if ("status" in expected) assert.equal(error.status, expected.status);
  if ("retryAfter" in expected) assert.equal(error.retryAfter, expected.retryAfter);
  return true;
}

function executionOptions(): ToolCallOptions {
  return { messages: [], toolCallId: "test-tool-call" };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreSerperApiKey();
});

test("serper resolves missing SERPER_API_KEY lazily at call time", async () => {
  delete process.env["SERPER_API_KEY"];
  const backend = serper();

  await assert.rejects(
    async () => backend({ query: "agent tools", topK: 5 }),
    (error) => assertProviderError(error, { code: "missing_api_key" }),
  );
});

test("serper POSTs to /search with headers and an array body for a single query", async () => {
  const { calls } = mockFetch(() =>
    jsonResponse({
      organic: [
        {
          title: "Agent Tools",
          link: "https://example.com/agent-tools",
          snippet: "A toolkit.",
          date: "Jan 1, 2026",
          position: 1,
        },
      ],
    }),
  );

  const hits = await serper({
    apiKey: "test-key",
    baseURL: "https://serper.test",
    gl: "us",
    hl: "en",
    page: 2,
    tbs: "qdr:d",
  })({ query: "agent tools", topK: 7 });

  const call = callAt(calls, 0);
  assert.equal(call.url, "https://serper.test/search");
  assert.equal(call.init?.method, "POST");
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-api-key"), "test-key");
  assert.deepEqual(requestBody(call), [
    { q: "agent tools", gl: "us", hl: "en", tbs: "qdr:d", page: 2, num: 7 },
  ]);
  assert.deepEqual(hits, [
    {
      title: "Agent Tools",
      url: "https://example.com/agent-tools",
      snippet: "A toolkit.",
      date: "Jan 1, 2026",
      position: 1,
      source: "serper",
    },
  ]);
});

test("serper accepts a single-object Serper response", async () => {
  mockFetch(() =>
    jsonResponse({
      organic: [{ title: "One", link: "https://example.com/one", snippet: "First." }],
    }),
  );

  const hits = await serper({ apiKey: "test-key", baseURL: "https://serper.test" })({
    query: "one",
    topK: 1,
  });

  assert.deepEqual(hits, [
    { title: "One", url: "https://example.com/one", snippet: "First.", source: "serper" },
  ]);
});

test("serper accepts an array Serper response for a single query", async () => {
  mockFetch(() =>
    jsonResponse([
      {
        organic: [{ title: "One", link: "https://example.com/one" }],
      },
    ]),
  );

  const hits = await serper({ apiKey: "test-key", baseURL: "https://serper.test" })({
    query: "one",
    topK: 1,
  });

  assert.deepEqual(hits, [{ title: "One", url: "https://example.com/one", source: "serper" }]);
});

test("serper batch returns ordered results for multiple query items", async () => {
  const { calls } = mockFetch(() =>
    jsonResponse([
      { organic: [{ title: "A", link: "https://example.com/a" }] },
      { organic: [{ title: "B", link: "https://example.com/b" }] },
    ]),
  );

  const results = await serper({ apiKey: "test-key", baseURL: "https://serper.test" }).batch([
    { q: "a" },
    { q: "b" },
  ]);

  assert.deepEqual(requestBody(callAt(calls, 0)), [{ q: "a" }, { q: "b" }]);
  assert.deepEqual(results, [
    [{ title: "A", url: "https://example.com/a", source: "serper" }],
    [{ title: "B", url: "https://example.com/b", source: "serper" }],
  ]);
});

test("serper batch rejects a single-object response for multiple query items", async () => {
  mockFetch(() =>
    jsonResponse({
      organic: [{ title: "Only A", link: "https://example.com/a" }],
    }),
  );

  await assert.rejects(
    async () =>
      serper({ apiKey: "test-key", baseURL: "https://serper.test" }).batch([
        { q: "a" },
        { q: "b" },
      ]),
    (error) => assertProviderError(error, { code: "invalid_response" }),
  );
});

test("serper batch rejects a response array shorter than the request array", async () => {
  mockFetch(() =>
    jsonResponse([{ organic: [{ title: "Only A", link: "https://example.com/a" }] }]),
  );

  await assert.rejects(
    async () =>
      serper({ apiKey: "test-key", baseURL: "https://serper.test" }).batch([
        { q: "a" },
        { q: "b" },
      ]),
    (error) => assertProviderError(error, { code: "invalid_response" }),
  );
});

test("serper batch item options override factory defaults", async () => {
  const { calls } = mockFetch(() => jsonResponse([{ organic: [] }, { organic: [] }]));

  await serper({
    apiKey: "test-key",
    baseURL: "https://serper.test",
    gl: "us",
    hl: "en",
    page: 1,
    tbs: "qdr:d",
  }).batch([{ q: "a" }, { q: "b", gl: "ca", hl: "fr", page: 4, tbs: "qdr:y", num: 50 }]);

  assert.deepEqual(requestBody(callAt(calls, 0)), [
    { q: "a", gl: "us", hl: "en", tbs: "qdr:d", page: 1 },
    { q: "b", gl: "ca", hl: "fr", tbs: "qdr:y", page: 4, num: 20 },
  ]);
});

test("serper batch validates outgoing query items with Zod", async () => {
  mockFetch(() => {
    throw new Error("fetch must not be called");
  });

  await assert.rejects(
    async () => serper({ apiKey: "test-key", baseURL: "https://serper.test" }).batch([{ q: "" }]),
    ZodError,
  );
});

test("serper wraps inbound schema validation failures", async () => {
  mockFetch(() => jsonResponse({ organic: [{ title: 123, link: "https://example.com" }] }));

  await assert.rejects(
    async () =>
      serper({ apiKey: "test-key", baseURL: "https://serper.test" })({
        query: "bad",
        topK: 1,
      }),
    (error) => {
      assertProviderError(error, { code: "invalid_response" });
      assert.ok(error instanceof SearchProviderError);
      assert.ok(error.cause instanceof ZodError);
      return true;
    },
  );
});

test("serper returns an empty hit list for a 200 response without organic results", async () => {
  mockFetch(() => jsonResponse({ knowledgeGraph: { title: "Only KG" } }));

  const hits = await serper({ apiKey: "test-key", baseURL: "https://serper.test" })({
    query: "empty",
    topK: 3,
  });

  assert.deepEqual(hits, []);
});

test("serper ignores unknown organic fields because response schemas passthrough", async () => {
  mockFetch(() =>
    jsonResponse({
      organic: [{ title: "Known", link: "https://example.com/known", extraField: "ignored" }],
      unexpectedTopLevel: true,
    }),
  );

  const hits = await serper({ apiKey: "test-key", baseURL: "https://serper.test" })({
    query: "known",
    topK: 1,
  });

  assert.deepEqual(hits, [{ title: "Known", url: "https://example.com/known", source: "serper" }]);
});

test("serper throws SearchProviderError for HTTP error statuses", async () => {
  const cases = [
    { status: 401, statusText: "Unauthorized" },
    { status: 429, statusText: "Too Many Requests", retryAfter: "30" },
    { status: 500, statusText: "Internal Server Error" },
  ];
  let index = 0;
  mockFetch(() => {
    const current = cases[index];
    if (!current) throw new Error("unexpected fetch call");
    index += 1;
    return jsonResponse(
      { error: current.statusText },
      {
        status: current.status,
        statusText: current.statusText,
        ...(current.retryAfter !== undefined
          ? { headers: { "retry-after": current.retryAfter } }
          : {}),
      },
    );
  });

  const backend = serper({ apiKey: "test-key", baseURL: "https://serper.test" });
  await Promise.all(
    cases.map((current) =>
      assert.rejects(
        async () => backend({ query: "status", topK: 1 }),
        (error) =>
          assertProviderError(error, {
            status: current.status,
            retryAfter: current.retryAfter,
          }),
      ),
    ),
  );
});

test("serper composes and forwards caller AbortSignal to fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls } = mockFetch((_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, true);
    return jsonResponse({ organic: [] });
  });

  await serper({ apiKey: "test-key", baseURL: "https://serper.test" })({
    query: "abort",
    topK: 1,
    signal: controller.signal,
  });

  assert.equal(calls.length, 1);
});

test("serper clamps direct backend topK values into Serper num bounds", async () => {
  const { calls } = mockFetch(() => jsonResponse({ organic: [] }));
  const backend = serper({ apiKey: "test-key", baseURL: "https://serper.test" });

  await backend({ query: "low", topK: 0 });
  await backend({ query: "high", topK: 50 });

  assert.deepEqual(requestBody(callAt(calls, 0)), [{ q: "low", num: 1 }]);
  assert.deepEqual(requestBody(callAt(calls, 1)), [{ q: "high", num: 20 }]);
});

test("webSearch can use serper with query refinement disabled without calling the model", async () => {
  const { calls } = mockFetch(() => jsonResponse({ organic: [] }));
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("model must not be called");
    },
  });
  const searchTool = webSearch({
    backend: serper({ apiKey: "test-key", baseURL: "https://serper.test" }),
    model,
    refineQuery: false,
  });
  if (!searchTool.execute) throw new Error("webSearch tool is missing execute");

  const result = await searchTool.execute({ query: "original query", topK: 4 }, executionOptions());

  assert.deepEqual(requestBody(callAt(calls, 0)), [{ q: "original query", num: 4 }]);
  assert.equal(result.refinedQuery, "original query");
  assert.equal(result.synthesis, "No results.");
  assert.equal(model.doGenerateCalls.length, 0);
});
