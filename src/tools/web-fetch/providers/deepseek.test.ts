import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCallOptions } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { FetchProviderError } from "../fetch.ts";
import { webFetch, type WebFetchResult } from "../tool.ts";
import { clearDeepSeekFetchCache, deepseekFetch } from "./deepseek.ts";

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

function makeGenerateResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  };
}

function modelWithText(text = "model summary"): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doGenerate: makeGenerateResult(text) });
}

function executionOptions(): ToolCallOptions {
  return { messages: [], toolCallId: "test-tool-call" };
}

function assertProviderError(
  error: unknown,
  expected: { code?: string; status?: number; retryAfter?: string },
): true {
  assert.ok(error instanceof FetchProviderError);
  assert.equal(error.provider, "deepseek");
  if ("code" in expected) assert.equal(error.code, expected.code);
  if ("status" in expected) assert.equal(error.status, expected.status);
  if ("retryAfter" in expected) assert.equal(error.retryAfter, expected.retryAfter);
  return true;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreDeepSeekApiKey();
  clearDeepSeekFetchCache();
});

test("deepseekFetch resolves missing DEEPSEEK_API_KEY lazily at call time", async () => {
  delete process.env["DEEPSEEK_API_KEY"];
  const fetcher = deepseekFetch();

  await assert.rejects(
    async () => fetcher("https://example.com/page", { signal: AbortSignal.timeout(1_000) }),
    (error) => assertProviderError(error, { code: "missing_api_key" }),
  );
});

test("deepseekFetch POSTs to /tools/fetch with bearer auth and returns markdown", async () => {
  const { calls } = mockFetch(() =>
    jsonResponse({ title: "Example article", content: "# Example article\n\nBody." }),
  );

  const result = await deepseekFetch({
    apiKey: "test-key",
    baseURL: "https://deepseek.test/v1",
  })("http://example.com/article", { signal: AbortSignal.timeout(1_000) });

  const call = callAt(calls, 0);
  assert.equal(call.url, "https://deepseek.test/v1/tools/fetch");
  assert.equal(call.init?.method, "POST");
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer test-key");
  // http is upgraded to https before being sent
  assert.deepEqual(JSON.parse(String(call.init?.body)), { url: "https://example.com/article" });

  assert.equal("type" in result, false);
  if (!("type" in result)) {
    assert.equal(result.code, 200);
    assert.equal(result.contentType, "text/markdown");
    assert.equal(result.isBinary, false);
    assert.equal(result.url, "https://example.com/article");
    assert.equal(result.content, "# Example article\n\nBody.");
  }
});

test("deepseekFetch validates URLs before hitting the network", async () => {
  mockFetch(() => {
    throw new Error("fetch must not be called");
  });
  const fetcher = deepseekFetch({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" });

  await assert.rejects(async () =>
    fetcher("https://user:pass@example.com/x", { signal: AbortSignal.timeout(1_000) }),
  );
  await assert.rejects(async () =>
    fetcher("https://127.0.0.1/admin", { signal: AbortSignal.timeout(1_000) }),
  );
});

test("deepseekFetch caches successful fetches by URL", async () => {
  const { calls } = mockFetch(() => jsonResponse({ title: "t", content: "cached body" }));
  const fetcher = deepseekFetch({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" });

  const first = await fetcher("https://example.com/cached", { signal: AbortSignal.timeout(1_000) });
  const second = await fetcher("https://example.com/cached", {
    signal: AbortSignal.timeout(1_000),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(first, second);
});

test("deepseekFetch cache can be disabled", async () => {
  const { calls } = mockFetch(() => jsonResponse({ title: "t", content: "body" }));
  const fetcher = deepseekFetch({
    apiKey: "test-key",
    baseURL: "https://deepseek.test/v1",
    cache: false,
  });

  await fetcher("https://example.com/no-cache", { signal: AbortSignal.timeout(1_000) });
  await fetcher("https://example.com/no-cache", { signal: AbortSignal.timeout(1_000) });

  assert.equal(calls.length, 2);
});

test("deepseekFetch throws FetchProviderError with the API error message for HTTP errors", async () => {
  const cases = [
    { status: 401, message: "Invalid API key" },
    { status: 403, message: "Rejected by the security policy" },
    { status: 404, message: "Could not retrieve usable page content" },
    { status: 429, message: "Rate limit exceeded", retryAfter: "1" },
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

  const fetcher = deepseekFetch({
    apiKey: "test-key",
    baseURL: "https://deepseek.test/v1",
    cache: false,
  });
  await Promise.all(
    cases.map((current) =>
      assert.rejects(
        async () =>
          fetcher(`https://example.com/err-${current.status}`, {
            signal: AbortSignal.timeout(1_000),
          }),
        (error) => {
          assertProviderError(error, {
            status: current.status,
            ...(current.retryAfter !== undefined ? { retryAfter: current.retryAfter } : {}),
          });
          assert.ok(error instanceof FetchProviderError);
          assert.match(error.message, new RegExp(current.message));
          return true;
        },
      ),
    ),
  );
});

test("deepseekFetch wraps inbound schema validation failures", async () => {
  mockFetch(() => jsonResponse({ title: "t" }));

  await assert.rejects(
    async () =>
      deepseekFetch({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" })(
        "https://example.com/bad",
        { signal: AbortSignal.timeout(1_000) },
      ),
    (error) => assertProviderError(error, { code: "invalid_response" }),
  );
});

test("webFetch uses an injected fetcher and runs the secondary model on its markdown", async () => {
  const model = modelWithText("deepseek summary");
  mockFetch(() => jsonResponse({ title: "t", content: "# Page\n\nSome body text." }));

  const fetchTool = webFetch({
    fetcher: deepseekFetch({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" }),
    model,
  });
  if (!fetchTool.execute) throw new Error("webFetch tool is missing execute");
  const result: WebFetchResult = await fetchTool.execute(
    { url: "https://example.com/article", prompt: "Summarize" },
    executionOptions(),
  );

  assert.equal(result.result, "deepseek summary");
  assert.equal(result.code, 200);
  assert.equal(result.url, "https://example.com/article");
  assert.equal(model.doGenerateCalls.length, 1);
});

test("webFetch with an injected fetcher still short-circuits preapproved markdown", async () => {
  const model = modelWithText("unused");
  mockFetch(() => jsonResponse({ title: "t", content: "# React docs" }));

  const fetchTool = webFetch({
    fetcher: deepseekFetch({ apiKey: "test-key", baseURL: "https://deepseek.test/v1" }),
    model,
  });
  if (!fetchTool.execute) throw new Error("webFetch tool is missing execute");
  const result = await fetchTool.execute(
    { url: "https://react.dev/", prompt: "Return docs" },
    executionOptions(),
  );

  assert.equal(result.result, "# React docs");
  assert.equal(model.doGenerateCalls.length, 0);
});
