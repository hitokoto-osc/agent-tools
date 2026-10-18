import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ZodError } from "zod";
import { deepseek, type DeepSeekRequest } from "./deepseek.ts";
import { SearchProviderError } from "../types.ts";

const originalFetch = globalThis.fetch;
const originalDeepSeekApiKey = process.env["DEEPSEEK_API_KEY"];

interface FetchCall {
  url: string;
  init: Parameters<typeof fetch>[1];
}

function restoreDeepSeekApiKey(): void {
  if (originalDeepSeekApiKey === undefined) {
    delete process.env["DEEPSEEK_API_KEY"];
  } else {
    process.env["DEEPSEEK_API_KEY"] = originalDeepSeekApiKey;
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

function requestBody(call: FetchCall): DeepSeekRequest {
  assert.equal(typeof call.init?.body, "string");
  return JSON.parse(call.init.body) as DeepSeekRequest;
}

function makeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rerank_score: 2.4,
    title: "DeepSeek V4 model released",
    url: "https://example.com/deepseek-v4",
    snippet: "Short display blurb.",
    summary: "Long model-oriented abstract.",
    content: "",
    site_name: "Example News",
    site_icon: "https://example.com/favicon.ico",
    date: "2026-06-01T00:00:00+00:00",
    authority: 3,
    ...overrides,
  };
}

function assertProviderError(
  error: unknown,
  expected: { code?: string; status?: number; retryAfter?: string },
): true {
  assert.ok(error instanceof SearchProviderError);
  assert.equal(error.provider, "deepseek");
  if ("code" in expected) assert.equal(error.code, expected.code);
  if ("status" in expected) assert.equal(error.status, expected.status);
  if ("retryAfter" in expected) assert.equal(error.retryAfter, expected.retryAfter);
  return true;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreDeepSeekApiKey();
});

test("deepseek resolves missing DEEPSEEK_API_KEY lazily at call time", async () => {
  delete process.env["DEEPSEEK_API_KEY"];
  const backend = deepseek();

  await assert.rejects(
    async () => backend({ query: "agent tools", topK: 5 }),
    (error) => assertProviderError(error, { code: "missing_api_key" }),
  );
});

test("deepseek falls back to DEEPSEEK_API_KEY from the environment", async () => {
  process.env["DEEPSEEK_API_KEY"] = "env-key";
  const { calls } = mockFetch(() => jsonResponse({ results: [] }));

  await deepseek({ baseURL: "https://deepseek.test/v1" })({ query: "agent tools", topK: 5 });

  const headers = new Headers(callAt(calls, 0).init?.headers);
  assert.equal(headers.get("authorization"), "Bearer env-key");
});

test("deepseek POSTs to /tools/search with bearer auth and mapped fields", async () => {
  const { calls } = mockFetch(() => jsonResponse({ results: [makeResult()] }));

  const hits = await deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" })({
    query: "DeepSeek V4 release",
    topK: 7,
  });

  const call = callAt(calls, 0);
  assert.equal(call.url, "https://deepseek.test/v1/tools/search");
  assert.equal(call.init?.method, "POST");
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.deepEqual(requestBody(call), {
    query: "DeepSeek V4 release",
    count: 7,
    need_content: false,
  });
  assert.deepEqual(hits, [
    {
      title: "DeepSeek V4 model released",
      url: "https://example.com/deepseek-v4",
      snippet: "Long model-oriented abstract.",
      date: "2026-06-01T00:00:00+00:00",
      position: 1,
      score: 2.4,
      authority: 3,
      source: "deepseek",
    },
  ]);
});

test("deepseek snippetSource=snippet prefers the short display blurb", async () => {
  mockFetch(() => jsonResponse({ results: [makeResult()] }));

  const hits = await deepseek({
    apiKey: "test-key",
    baseURL: "https://deepseek.test/v1",
    snippetSource: "snippet",
  })({ query: "q", topK: 1 });

  assert.equal(hits[0]?.snippet, "Short display blurb.");
});

test("deepseek falls back to the other text field when the chosen one is empty", async () => {
  mockFetch(() => jsonResponse({ results: [makeResult({ summary: "" })] }));

  const hits = await deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" })({
    query: "q",
    topK: 1,
  });

  assert.equal(hits[0]?.snippet, "Short display blurb.");
});

test("deepseek omits authority when the API reports it as unknown (-1)", async () => {
  mockFetch(() => jsonResponse({ results: [makeResult({ authority: -1, date: null })] }));

  const hits = await deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" })({
    query: "q",
    topK: 1,
  });

  const hit = hits[0];
  assert.ok(hit);
  assert.equal("authority" in hit, false);
  assert.equal("date" in hit, false);
});

test("deepseek needContent option is forwarded as need_content", async () => {
  const { calls } = mockFetch(() =>
    jsonResponse({ results: [makeResult({ content: "Full page body." })] }),
  );

  await deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1", needContent: true })({
    query: "q",
    topK: 1,
  });

  assert.equal(requestBody(callAt(calls, 0)).need_content, true);
});

test("deepseek returns an empty hit list for a 200 response without results", async () => {
  mockFetch(() => jsonResponse({ results: [] }));

  const hits = await deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" })({
    query: "empty",
    topK: 3,
  });

  assert.deepEqual(hits, []);
});

test("deepseek clamps topK into the DeepSeek count bounds (1-50)", async () => {
  const { calls } = mockFetch(() => jsonResponse({ results: [] }));
  const backend = deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" });

  await backend({ query: "low", topK: 0 });
  await backend({ query: "high", topK: 500 });

  assert.equal(requestBody(callAt(calls, 0)).count, 1);
  assert.equal(requestBody(callAt(calls, 1)).count, 50);
});

test("deepseek validates the outgoing request with Zod", async () => {
  mockFetch(() => {
    throw new Error("fetch must not be called");
  });

  await assert.rejects(
    async () =>
      deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" })({
        query: "x".repeat(129),
        topK: 1,
      }),
    ZodError,
  );
  await assert.rejects(
    async () =>
      deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" })({
        query: "   ",
        topK: 1,
      }),
    ZodError,
  );
});

test("deepseek wraps inbound schema validation failures", async () => {
  mockFetch(() => jsonResponse({ results: [{ title: 123 }] }));

  await assert.rejects(
    async () =>
      deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" })({
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

test("deepseek throws SearchProviderError with the API error message for HTTP errors", async () => {
  const cases = [
    { status: 401, message: "Invalid API key" },
    { status: 402, message: "Insufficient balance" },
    { status: 429, message: "Rate limit exceeded", retryAfter: "1" },
    { status: 500, message: "Internal server error" },
  ];
  let index = 0;
  mockFetch(() => {
    const current = cases[index];
    if (!current) throw new Error("unexpected fetch call");
    index += 1;
    return jsonResponse(
      { error: { message: current.message, type: "error", param: null, code: "error" } },
      {
        status: current.status,
        statusText: "Error",
        ...(current.retryAfter !== undefined
          ? { headers: { "retry-after": current.retryAfter } }
          : {}),
      },
    );
  });

  const backend = deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" });
  await Promise.all(
    cases.map((current) =>
      assert.rejects(
        async () => backend({ query: "status", topK: 1 }),
        (error) => {
          assertProviderError(error, {
            status: current.status,
            ...(current.retryAfter !== undefined ? { retryAfter: current.retryAfter } : {}),
          });
          assert.ok(error instanceof SearchProviderError);
          assert.match(error.message, new RegExp(current.message));
          return true;
        },
      ),
    ),
  );
});

test("deepseek composes and forwards caller AbortSignal to fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls } = mockFetch((_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, true);
    return jsonResponse({ results: [] });
  });

  await deepseek({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" })({
    query: "abort",
    topK: 1,
    signal: controller.signal,
  });

  assert.equal(calls.length, 1);
});
