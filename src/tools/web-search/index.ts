export { webSearch, webSearchInputSchema, webSearchOutputSchema } from "./tool.ts";
export type { WebSearchInput, WebSearchOptions, WebSearchResult } from "./tool.ts";

export { SearchProviderError } from "./types.ts";
export type {
  SearchBackend,
  SearchBackendArgs,
  SearchHit,
  SearchProviderErrorOptions,
} from "./types.ts";

export {
  deepseek,
  deepseekRequestSchema,
  deepseekResponseSchema,
  deepseekResultSchema,
} from "./providers/deepseek.ts";
export type {
  DeepSeekOptions,
  DeepSeekRequest,
  DeepSeekResponse,
  DeepSeekResult,
} from "./providers/deepseek.ts";

export {
  serper,
  serperQueryItemSchema,
  serperResponseListSchema,
  serperResponseSchema,
} from "./providers/serper.ts";
export type {
  SerperBackend,
  SerperBatchFn,
  SerperOptions,
  SerperQueryItem,
  SerperResponse,
} from "./providers/serper.ts";
