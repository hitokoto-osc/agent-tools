import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export interface OpenAICompatibleConfig {
  /** Provider display name (used by the AI SDK for telemetry / errors). */
  name?: string;
  /** Base URL of the OpenAI-compatible HTTP endpoint, e.g. `https://api.openai.com/v1`. */
  baseURL: string;
  /** API key. Falls back to `OPENAI_API_KEY` when omitted. */
  apiKey?: string;
  /** Extra HTTP headers forwarded with every request. */
  headers?: Record<string, string>;
  /** Optional query parameters appended to every request URL. */
  queryParams?: Record<string, string>;
}

export interface DefaultModelConfig extends OpenAICompatibleConfig {
  /** Model id resolved by the upstream provider, e.g. `gpt-4o-mini`. */
  modelId: string;
}

const DEFAULT_BASE_URL =
  process.env["OPENAI_BASE_URL"] ?? process.env["OPENAI_API_BASE"] ?? "https://api.openai.com/v1";

const DEFAULT_MODEL_ID = process.env["AGENT_TOOLS_MODEL"] ?? "gpt-4o-mini";

/**
 * Build a reusable OpenAI-compatible provider. The returned value is a
 * factory: call it with a model id (e.g. `provider('gpt-4o-mini')`) to get
 * a `LanguageModel` consumable by `generateText` / `streamText`.
 */
export function createProvider(
  config: Partial<OpenAICompatibleConfig> = {},
): OpenAICompatibleProvider {
  const apiKey = config.apiKey ?? process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("[agent-tools] Missing API key. Pass `apiKey` or set OPENAI_API_KEY.");
  }
  return createOpenAICompatible({
    name: config.name ?? "openai-compatible",
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    apiKey,
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.queryParams ? { queryParams: config.queryParams } : {}),
  });
}

/**
 * Resolve a default `LanguageModel` instance. Used by tools that need an
 * internal LLM (e.g. summarisation in `webFetch`) when the caller does not
 * supply one explicitly.
 */
export function defaultModel(config: Partial<DefaultModelConfig> = {}): LanguageModel {
  const provider = createProvider(config);
  return provider(config.modelId ?? DEFAULT_MODEL_ID);
}
