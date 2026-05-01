import { tool, type LanguageModel } from "ai";
import { z } from "zod";
import { defaultModel } from "../../model.js";
import {
  applyPromptToMarkdown,
  DEFAULT_USER_AGENT,
  FETCH_TIMEOUT_MS,
  getURLMarkdownContent,
  isMarkdownContentType,
  isPreapprovedUrl,
  isRedirectInfo,
  MAX_HTTP_CONTENT_LENGTH,
  MAX_MARKDOWN_LENGTH,
  redirectStatusText,
} from "./fetch.js";
import { DESCRIPTION } from "./prompt.js";

export const webFetchInputSchema = z.object({
  url: z.string().url().describe("Absolute URL to fetch."),
  prompt: z
    .string()
    .min(1)
    .describe("Instruction the secondary model applies to the fetched content."),
});

export const webFetchOutputSchema = z.object({
  bytes: z.number().describe("Size of the fetched content in bytes."),
  code: z.number().describe("HTTP response code."),
  codeText: z.string().describe("HTTP response code text."),
  result: z.string().describe("Processed result from applying the prompt to the content."),
  durationMs: z.number().describe("Time taken to fetch and process the content."),
  url: z.string().describe("The URL that was fetched."),
});

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;
export type WebFetchResult = z.infer<typeof webFetchOutputSchema>;

export interface WebFetchOptions {
  /** Override the LLM used for summarisation. Defaults to `defaultModel()`. */
  model?: LanguageModel;
  /** Hard cap on raw bytes downloaded before truncation. Default 10 MiB. */
  maxContentBytes?: number;
  /** Hard cap on markdown characters fed into the summariser. Default 100_000. */
  maxMarkdownChars?: number;
  /** Default User-Agent. */
  userAgent?: string;
  /** Request timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** @deprecated Use `maxContentBytes`. */
  maxBytes?: number;
  /** @deprecated Use `maxMarkdownChars`. */
  maxChars?: number;
}

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

// Combine the caller-supplied AbortSignal (if any) with our own timeout signal
// so either source can cancel the fetch.
function combinedSignal(timeoutMs: number, abortSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
}

function redirectResult(
  url: string,
  prompt: string,
  statusCode: number,
  originalUrl: string,
  redirectUrl: string,
  start: number,
): WebFetchResult {
  const codeText = redirectStatusText(statusCode);
  const message = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${originalUrl}
Redirect URL: ${redirectUrl}
Status: ${statusCode} ${codeText}

To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:
- url: "${redirectUrl}"
- prompt: "${prompt}"`;

  return {
    bytes: Buffer.byteLength(message),
    code: statusCode,
    codeText,
    result: message,
    durationMs: Date.now() - start,
    url,
  };
}

export function webFetch(options: WebFetchOptions = {}) {
  const maxContentBytes = resolvePositiveInteger(
    options.maxContentBytes ?? options.maxBytes,
    MAX_HTTP_CONTENT_LENGTH,
  );
  const maxMarkdownChars = resolvePositiveInteger(
    options.maxMarkdownChars ?? options.maxChars,
    MAX_MARKDOWN_LENGTH,
  );
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = resolvePositiveInteger(options.timeoutMs, FETCH_TIMEOUT_MS);
  // Defer defaultModel() until execution so that constructing the tool doesn't
  // require an API key when only the schema is needed (e.g., MCP listing).
  const resolveModel = (): LanguageModel => options.model ?? defaultModel();

  return tool({
    description:
      "IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.\n" +
      DESCRIPTION,
    inputSchema: webFetchInputSchema,
    outputSchema: webFetchOutputSchema,
    execute: async ({ url, prompt }, { abortSignal }): Promise<WebFetchResult> => {
      const start = Date.now();
      const signal = combinedSignal(timeoutMs, abortSignal);

      const response = await getURLMarkdownContent(url, {
        maxContentBytes,
        signal,
        userAgent,
      });

      if (isRedirectInfo(response)) {
        return redirectResult(
          url,
          prompt,
          response.statusCode,
          response.originalUrl,
          response.redirectUrl,
          start,
        );
      }

      const isPreapproved = isPreapprovedUrl(response.url);
      const shouldShortCircuit =
        response.isBinary ||
        (isPreapproved &&
          isMarkdownContentType(response.contentType) &&
          response.content.length < maxMarkdownChars);

      const result = shouldShortCircuit
        ? response.content
        : await applyPromptToMarkdown({
            abortSignal: signal,
            content: response.content,
            isPreapproved,
            maxMarkdownChars,
            model: resolveModel(),
            prompt,
          });

      return {
        bytes: response.bytes,
        code: response.code,
        codeText: response.codeText,
        result,
        durationMs: Date.now() - start,
        url: response.url,
      };
    },
  });
}
