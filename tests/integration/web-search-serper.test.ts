import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCallOptions } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { serper, webSearch } from "../../src/tools/web-search/index.js";
import type { WebSearchInput, WebSearchResult } from "../../src/tools/web-search/index.js";

const apiKey = process.env["SERPER_API_KEY"];
const required = process.env["AGENT_TOOLS_INTEGRATION_REQUIRED"] === "1";

if (!apiKey && required) {
  throw new Error(
    "AGENT_TOOLS_INTEGRATION_REQUIRED=1 but SERPER_API_KEY missing - refusing to skip.",
  );
}

const skipReason: string | false = apiKey
  ? false
  : "SERPER_API_KEY not set; configure .env (see .env.example).";

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

function modelWithText(text = "integration synthesis"): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doGenerate: makeGenerateResult(text) });
}

async function invoke(input: WebSearchInput): Promise<WebSearchResult> {
  const searchTool = webSearch({
    backend: serper(),
    model: modelWithText(),
    refineQuery: false,
  });
  if (!searchTool.execute) throw new Error("webSearch tool is missing execute");
  const result = await searchTool.execute(input, {
    messages: [],
    toolCallId: "integration-test",
  } as ToolCallOptions);
  return result as WebSearchResult;
}

test("webSearch uses Serper for a real single query", { skip: skipReason }, async () => {
  const result = await invoke({
    query: "site:example.com Example Domain",
    topK: 3,
  });

  assert.ok(result.hits.length >= 1, "expected at least one hit");
  assert.match(result.hits[0]?.url ?? "", /^https?:\/\//);
  assert.equal(result.synthesis, "integration synthesis");
});

test(
  "serper batch uses real network and preserves response order",
  { skip: skipReason },
  async () => {
    const results = await serper().batch([
      { q: "apple inc", num: 3 },
      { q: "google inc", num: 3 },
    ]);

    assert.equal(results.length, 2);
    assert.ok((results[0]?.length ?? 0) >= 1, "expected apple results");
    assert.ok((results[1]?.length ?? 0) >= 1, "expected google results");
    assert.match(results[0]?.[0]?.url ?? "", /^https?:\/\//);
    assert.match(results[1]?.[0]?.url ?? "", /^https?:\/\//);
    const firstBlob = (results[0] ?? [])
      .map((hit) => `${hit.title} ${hit.url}`)
      .join(" ")
      .toLowerCase();
    const secondBlob = (results[1] ?? [])
      .map((hit) => `${hit.title} ${hit.url}`)
      .join(" ")
      .toLowerCase();
    assert.ok(
      firstBlob.includes("apple"),
      `expected apple-related results in first group, got: ${firstBlob.slice(0, 200)}`,
    );
    assert.ok(
      secondBlob.includes("google"),
      `expected google-related results in second group, got: ${secondBlob.slice(0, 200)}`,
    );
  },
);
