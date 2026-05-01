export { webSearch, webSearchInputSchema, webSearchOutputSchema } from "./tool.js";
export type { WebSearchInput, WebSearchOptions, WebSearchResult } from "./tool.js";

export { SearchProviderError } from "./types.js";
export type {
  SearchBackend,
  SearchBackendArgs,
  SearchHit,
  SearchProviderErrorOptions,
} from "./types.js";

export {
  serper,
  serperQueryItemSchema,
  serperResponseListSchema,
  serperResponseSchema,
} from "./providers/serper.js";
export type {
  SerperBackend,
  SerperBatchFn,
  SerperOptions,
  SerperQueryItem,
  SerperResponse,
} from "./providers/serper.js";
