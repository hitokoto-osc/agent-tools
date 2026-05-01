import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ToolCallOptions } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { clearWebFetchCache, webFetch } from "../../src/tools/web-fetch/index.js";
import type { WebFetchInput, WebFetchResult } from "../../src/tools/web-fetch/index.js";

const apiKey = process.env["OPENAI_API_KEY"];
const required = process.env["AGENT_TOOLS_INTEGRATION_REQUIRED"] === "1";

if (!apiKey && required) {
  throw new Error(
    "AGENT_TOOLS_INTEGRATION_REQUIRED=1 but OPENAI_API_KEY missing — refusing to skip.",
  );
}

const skipReason: string | false = apiKey
  ? false
  : "OPENAI_API_KEY not set; configure .env (see .env.example).";

beforeEach(() => clearWebFetchCache());

async function invoke(
  options: Parameters<typeof webFetch>[0],
  input: WebFetchInput,
): Promise<WebFetchResult> {
  const fetchTool = webFetch(options);
  if (!fetchTool.execute) throw new Error("webFetch tool is missing execute");
  const result = await fetchTool.execute(input, {
    messages: [],
    toolCallId: "integration-test",
  } as ToolCallOptions);
  return result as WebFetchResult;
}

test(
  "summarises a real HTML page using the configured live model",
  { skip: skipReason },
  async () => {
    const baseURL = process.env["OPENAI_BASE_URL"];
    const modelId = process.env["AGENT_TOOLS_MODEL"];
    const result = await invoke(
      {
        timeoutMs: 60_000,
        ...(baseURL ? { baseURL } : {}),
        ...(modelId ? { modelId } : {}),
      },
      {
        url: "https://en.wikipedia.org/wiki/HTTP",
        prompt: "Reply with one short sentence describing what this page is about.",
      },
    );

    assert.equal(result.code, 200);
    assert.ok(result.bytes > 0, "expected non-zero bytes");
    assert.ok(result.result.length > 0, "expected non-empty model output");
    assert.match(result.url, /en\.wikipedia\.org\/wiki\/HTTP/);
  },
);

test("binary content short-circuits without invoking the model", async () => {
  const throwingModel = new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("model must not be called for binary short-circuit");
    },
  });

  const result = await invoke(
    { model: throwingModel, timeoutMs: 15_000 },
    {
      url: "https://www.iana.org/favicon.ico",
      prompt: "Should not be used.",
    },
  );

  assert.equal(result.code, 200);
  assert.ok(result.result.startsWith("[Binary content"), `unexpected result: ${result.result}`);
  assert.equal(throwingModel.doGenerateCalls.length, 0);
});
