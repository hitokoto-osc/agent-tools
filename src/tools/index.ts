export {
  clearWebFetchCache,
  isPreapprovedHost,
  PREAPPROVED_HOSTS,
  webFetch,
  webFetchInputSchema,
  webFetchOutputSchema,
} from "./web-fetch.js";
export type { WebFetchInput, WebFetchOptions, WebFetchResult } from "./web-fetch.js";

export { webSearch } from "./web-search.js";
export type { WebSearchOptions, WebSearchResult, SearchBackend, SearchHit } from "./web-search.js";
