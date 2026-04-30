import { generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { defaultModel } from "../model.js";

export interface WebFetchOptions {
  /** Override the LLM used for summarisation. Defaults to `defaultModel()`. */
  model?: LanguageModel;
  /** Hard cap on raw bytes downloaded before truncation. Default 2 MiB. */
  maxBytes?: number;
  /** Hard cap on characters of cleaned text fed into the summariser. Default 60_000. */
  maxChars?: number;
  /** Default User-Agent. */
  userAgent?: string;
  /** Request timeout in ms. Default 20_000. */
  timeoutMs?: number;
}

const DEFAULT_USER_AGENT = "agent-tools/0.1 (+https://github.com/) WebFetch";

const inputSchema = z.object({
  url: z.string().url().describe("Absolute URL to fetch."),
  goal: z
    .string()
    .min(1)
    .describe("What the caller wants to learn from this page. Drives the summary focus."),
  maxSummaryTokens: z
    .number()
    .int()
    .positive()
    .max(4000)
    .default(800)
    .describe("Soft upper bound on summary length, expressed in tokens."),
});

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  truncated: boolean;
  summary: string;
}

/** Strip HTML/script/style and collapse whitespace into a readable text blob. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `webFetch` — fetch a URL and return a goal-directed summary produced by
 * the configured LLM. Suitable for exposing to other agents as a tool_call
 * or wrapping behind an MCP server.
 */
export function webFetch(options: WebFetchOptions = {}) {
  const {
    model = defaultModel(),
    maxBytes = 2 * 1024 * 1024,
    maxChars = 60_000,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = 20_000,
  } = options;

  return tool({
    description:
      "Fetch a web page and return an LLM-generated summary focused on the caller-provided goal. " +
      "Use this instead of raw HTTP when the agent only needs the gist of a page.",
    inputSchema,
    execute: async ({ url, goal, maxSummaryTokens }): Promise<WebFetchResult> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { "user-agent": userAgent, accept: "text/html,*/*;q=0.8" },
          signal: controller.signal,
          redirect: "follow",
        });
      } finally {
        clearTimeout(timeout);
      }

      const contentType = response.headers.get("content-type") ?? "";
      const buffer = await response.arrayBuffer();
      const truncated = buffer.byteLength > maxBytes;
      const slice = truncated ? buffer.slice(0, maxBytes) : buffer;
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      const isHtml = /text\/html|application\/xhtml/i.test(contentType);
      const text = isHtml ? htmlToText(raw) : raw;
      const clipped = text.length > maxChars ? text.slice(0, maxChars) : text;

      const { text: summary } = await generateText({
        model,
        maxOutputTokens: maxSummaryTokens,
        system:
          "You summarise web content for an autonomous agent. Be factual, " +
          "preserve concrete numbers, names and quotes when relevant to the goal. " +
          "Do not invent information that is not in the source.",
        prompt: [
          `URL: ${response.url || url}`,
          `Caller goal: ${goal}`,
          `Content (truncated=${truncated || text.length > maxChars}):`,
          "---",
          clipped,
        ].join("\n"),
      });

      return {
        url,
        finalUrl: response.url || url,
        status: response.status,
        contentType,
        truncated: truncated || text.length > maxChars,
        summary,
      };
    },
  });
}
