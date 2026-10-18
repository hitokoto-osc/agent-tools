import assert from "node:assert/strict";
import { test } from "node:test";
import { deepseek } from "../../src/tools/web-search/index.ts";

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

test("deepseek backend runs a real search query", { skip: skipReason }, async () => {
  const hits = await deepseek()({ query: "DeepSeek V3.2 release", topK: 3 });

  assert.ok(hits.length >= 1, "expected at least one hit");
  const first = hits[0];
  assert.ok(first);
  assert.match(first.url, /^https?:\/\//);
  assert.equal(first.source, "deepseek");
  assert.equal(typeof first.score, "number");
});
