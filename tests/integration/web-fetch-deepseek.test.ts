import assert from "node:assert/strict";
import { test } from "node:test";
import { deepseekFetch } from "../../src/tools/web-fetch/index.js";

const apiKey = process.env["DEEPSEEK_API_KEY"];
const required = process.env["AGENT_TOOLS_INTEGRATION_REQUIRED"] === "1";

if (!apiKey && required) {
  throw new Error(
    "AGENT_TOOLS_INTEGRATION_REQUIRED=1 but DEEPSEEK_API_KEY missing - refusing to skip.",
  );
}

const skipReason: string | false = apiKey
  ? false
  : "DEEPSEEK_API_KEY not set; configure .env (see .env.example).";

test("deepseekFetch retrieves a real page as markdown", { skip: skipReason }, async () => {
  const result = await deepseekFetch()("https://example.com/", {
    signal: AbortSignal.timeout(30_000),
  });

  assert.equal("type" in result, false);
  if (!("type" in result)) {
    assert.equal(result.code, 200);
    // DeepSeek returns a localized variant of example.com, so don't pin the language.
    assert.ok(result.content.length > 0, "expected non-empty markdown content");
  }
});
