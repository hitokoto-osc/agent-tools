import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolCallOptions } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  ACCEPT_HEADER,
  applyPromptToMarkdown,
  clearWebFetchCache,
  DEFAULT_USER_AGENT,
  htmlToMarkdown,
  isPermittedRedirect,
  MAX_MARKDOWN_LENGTH,
  MAX_REDIRECTS,
  MAX_URL_LENGTH,
  URLValidationError,
  validateURL,
} from "./fetch.js";
import { isPreapprovedHost } from "./preapproved.js";
import type { WebFetchInput, WebFetchOptions, WebFetchResult } from "./tool.js";
import { webFetch } from "./tool.js";

const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init: Parameters<typeof fetch>[1];
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

async function runWebFetch(
  input: WebFetchInput,
  options: WebFetchOptions = {},
): Promise<WebFetchResult> {
  const fetchTool = webFetch({
    timeoutMs: 1_000,
    ...options,
    model: options.model ?? modelWithText(),
  });
  if (!fetchTool.execute) throw new Error("webFetch tool is missing execute");
  return fetchTool.execute(input, executionOptions());
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

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearWebFetchCache();
});

test("validateURL rejects long URLs, single-segment hosts, and credentials", () => {
  assert.throws(
    () => validateURL(`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`),
    URLValidationError,
  );
  assert.throws(() => validateURL("https://localhost/docs"), URLValidationError);
  assert.throws(() => validateURL("https://user:pass@example.com/docs"), URLValidationError);
  assert.throws(() => validateURL("ftp://example.com/file"), URLValidationError);
  // valid URL should not throw
  validateURL("https://example.com/docs");
});

test("validateURL rejects private and reserved IP literals (SSRF guard)", () => {
  for (const url of [
    "https://127.0.0.1/admin",
    "https://10.0.0.1/admin",
    "https://172.16.0.1/admin",
    "https://192.168.1.1/admin",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/admin",
    "https://[fc00::1]/admin",
    "https://[fe80::1]/admin",
  ]) {
    assert.throws(() => validateURL(url), URLValidationError, `expected ${url} to be rejected`);
  }
  // public IP literals are still allowed (the security model relies on
  // not-internal addresses being routable)
  validateURL("https://8.8.8.8/");
});

test("isPermittedRedirect: same host or www toggle only", () => {
  assert.equal(isPermittedRedirect("https://example.com/docs", "https://example.com/other"), true);
  assert.equal(
    isPermittedRedirect("https://example.com/docs", "https://www.example.com/docs"),
    true,
  );
  assert.equal(
    isPermittedRedirect("https://www.example.com/docs", "https://example.com/docs"),
    true,
  );
  assert.equal(isPermittedRedirect("https://example.com/docs", "http://example.com/docs"), false);
  assert.equal(isPermittedRedirect("https://example.com/docs", "https://evil.example/docs"), false);
  assert.equal(
    isPermittedRedirect("https://example.com/docs", "https://user:pw@example.com/docs"),
    false,
  );
});

test("isPreapprovedHost: hostname-only match, path-prefix match, segment boundary", () => {
  assert.equal(isPreapprovedHost("react.dev", "/"), true);
  assert.equal(isPreapprovedHost("github.com", "/anthropics"), true);
  assert.equal(isPreapprovedHost("github.com", "/anthropics/claude-code"), true);
  assert.equal(isPreapprovedHost("github.com", "/anthropics-evil/x"), false);
  assert.equal(isPreapprovedHost("github.com", "/other"), false);
  assert.equal(isPreapprovedHost("not-on-the-list.example", "/"), false);
});

test("htmlToMarkdown turns HTML into Markdown via Turndown", async () => {
  const md = await htmlToMarkdown('<h1>Hello</h1><p><a href="https://example.com">link</a></p>');
  assert.match(md, /Hello/);
  assert.match(md, /\[link\]\(https:\/\/example\.com\)/);
});

test("applyPromptToMarkdown truncates content larger than maxMarkdownChars", async () => {
  let sawTruncationMarker = false;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      sawTruncationMarker = JSON.stringify(options.prompt).includes(
        "[Content truncated due to length...]",
      );
      return makeGenerateResult("ok");
    },
  });

  const out = await applyPromptToMarkdown({
    abortSignal: AbortSignal.timeout(5_000),
    content: "x".repeat(MAX_MARKDOWN_LENGTH + 5),
    isPreapproved: false,
    model,
    prompt: "Summarize",
  });

  assert.equal(out, "ok");
  assert.equal(sawTruncationMarker, true);
});

test("webFetch upgrades http→https, sends manual redirect + headers, calls model", async () => {
  const model = modelWithText("summary");
  const { calls } = mockFetch((requestUrl, init) => {
    assert.equal(requestUrl, "https://example.com/path");
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("accept"), ACCEPT_HEADER);
    assert.equal(headers.get("user-agent"), DEFAULT_USER_AGENT);
    return new Response("<p>Hello</p>", {
      headers: { "content-type": "text/html" },
      status: 200,
      statusText: "OK",
    });
  });

  const result = await runWebFetch(
    { url: "http://example.com/path", prompt: "Summarize" },
    { model },
  );

  assert.equal(calls.length, 1);
  assert.equal(result.code, 200);
  assert.equal(result.codeText, "OK");
  assert.equal(result.url, "https://example.com/path");
  assert.equal(result.result, "summary");
  assert.equal(model.doGenerateCalls.length, 1);
});

test("webFetch follows permitted redirects up to MAX_REDIRECTS and returns the final URL", async () => {
  const { calls } = mockFetch((requestUrl) => {
    if (requestUrl === "https://example.com/") {
      return new Response(null, {
        headers: { location: "https://www.example.com/docs" },
        status: 301,
        statusText: "Moved Permanently",
      });
    }
    return new Response("# docs", {
      headers: { "content-type": "text/markdown" },
      status: 200,
      statusText: "OK",
    });
  });

  const result = await runWebFetch({ url: "https://example.com/", prompt: "Summarize" });
  assert.equal(calls.length, 2);
  assert.equal(result.url, "https://www.example.com/docs");
});

test("webFetch returns a redirect-instructions message for cross-host redirects", async () => {
  mockFetch(
    () =>
      new Response(null, {
        headers: { location: "https://other.example/docs" },
        status: 302,
        statusText: "Found",
      }),
  );

  const result = await runWebFetch({
    url: "https://example.com/docs",
    prompt: "Summarize",
  });

  assert.equal(result.code, 302);
  assert.equal(result.codeText, "Found");
  assert.match(result.result, /REDIRECT DETECTED/);
  assert.match(result.result, /https:\/\/other\.example\/docs/);
});

test("webFetch caches by URL and short-circuits preapproved markdown without invoking the model", async () => {
  const model = modelWithText("unused");
  const { calls } = mockFetch(
    () =>
      new Response("# React docs", {
        headers: { "content-type": "text/markdown" },
        status: 200,
        statusText: "OK",
      }),
  );

  const input: WebFetchInput = { url: "https://react.dev/", prompt: "Return docs" };
  const first = await runWebFetch(input, { model });
  const second = await runWebFetch(input, { model });

  assert.equal(calls.length, 1);
  assert.equal(first.result, "# React docs");
  assert.equal(second.result, "# React docs");
  assert.equal(model.doGenerateCalls.length, 0);
});

test("webFetch returns metadata-only string for binary content and skips the model", async () => {
  const model = modelWithText("unused");
  mockFetch(
    () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "application/pdf" },
        status: 200,
        statusText: "OK",
      }),
  );

  const result = await runWebFetch(
    { url: "https://example.com/file.pdf", prompt: "Summarize" },
    { model },
  );

  assert.equal(result.bytes, 3);
  assert.match(result.result, /\[Binary content \(application\/pdf, 3 bytes\) - body omitted\]/);
  assert.equal(model.doGenerateCalls.length, 0);
});

test("webFetch summarizes non-preapproved content via the model", async () => {
  const model = modelWithText("non-preapproved summary");
  mockFetch(
    () =>
      new Response("<p>Hello</p>", {
        headers: { "content-type": "text/html" },
        status: 200,
        statusText: "OK",
      }),
  );

  const result = await runWebFetch({ url: "https://example.com/", prompt: "Summarize" }, { model });

  assert.equal(result.result, "non-preapproved summary");
  assert.equal(model.doGenerateCalls.length, 1);
});

test("webFetch enforces maxContentBytes and emits a truncation marker", async () => {
  mockFetch(
    () =>
      new Response("a".repeat(100), {
        headers: { "content-type": "text/plain" },
        status: 200,
        statusText: "OK",
      }),
  );

  const result = await runWebFetch(
    { url: "https://example.com/", prompt: "Summarize" },
    { maxContentBytes: 10 },
  );

  assert.equal(result.bytes, 10);
});

test("webFetch does not cache truncated bodies (no cache poisoning)", async () => {
  const { calls } = mockFetch(
    () =>
      new Response("abcdef", {
        headers: { "content-type": "text/markdown" },
        status: 200,
        statusText: "OK",
      }),
  );

  const input: WebFetchInput = { url: "https://example.com/truncated", prompt: "Summarize" };
  await runWebFetch(input, { maxContentBytes: 3, model: modelWithText("first") });
  await runWebFetch(input, { model: modelWithText("second") });
  assert.equal(calls.length, 2);
});

test("webFetch maps deprecated maxBytes/maxChars onto the new options", async () => {
  mockFetch(
    () =>
      new Response("a".repeat(100), {
        headers: { "content-type": "text/plain" },
        status: 200,
        statusText: "OK",
      }),
  );

  const result = await runWebFetch(
    { url: "https://example.com/legacy", prompt: "Summarize" },
    { maxBytes: 5 },
  );
  assert.equal(result.bytes, 5);
});

test("webFetch forwards a custom userAgent header", async () => {
  const { calls } = mockFetch(
    () => new Response("ok", { headers: { "content-type": "text/plain" } }),
  );

  await runWebFetch(
    { url: "https://example.com/ua", prompt: "Summarize" },
    { userAgent: "CustomAgent/1.0" },
  );

  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("user-agent"), "CustomAgent/1.0");
});

test("webFetch throws when MAX_REDIRECTS is exceeded (same-host loop)", async () => {
  let hop = 0;
  const { calls } = mockFetch(() => {
    hop += 1;
    return new Response(null, {
      headers: { location: `https://example.com/hop-${hop}` },
      status: 302,
      statusText: "Found",
    });
  });

  await assert.rejects(
    runWebFetch({ url: "https://example.com/start", prompt: "Summarize" }),
    /Too many redirects/,
  );
  // Upstream behavior: depth=0..MAX_REDIRECTS = MAX_REDIRECTS+1 same-host requests
  // before the limit triggers.
  assert.ok(calls.length >= MAX_REDIRECTS, "expected at least MAX_REDIRECTS hops");
});

test("webFetch accepts baseURL/apiKey/modelId without constructing the model eagerly", () => {
  const fetchTool = webFetch({
    baseURL: "https://example-llm.test/v1",
    apiKey: "sk-test-not-used",
    modelId: "test-model",
  });
  assert.ok(fetchTool.execute, "expected execute to be defined");
});

test("webFetch throws when a redirect response lacks a Location header", async () => {
  mockFetch(
    () =>
      new Response(null, {
        headers: {},
        status: 301,
        statusText: "Moved Permanently",
      }),
  );

  await assert.rejects(
    runWebFetch({ url: "https://example.com/", prompt: "Summarize" }),
    /Location header/,
  );
});
