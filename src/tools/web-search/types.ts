export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
  position?: number;
  date?: string;
  source?: string;
}

export interface SearchBackendArgs {
  query: string;
  topK: number;
  signal?: AbortSignal;
}

/**
 * Pluggable backend that returns raw search hits. Decoupled from the model
 * layer so callers can wire in any provider or internal index.
 */
export type SearchBackend = (args: SearchBackendArgs) => Promise<SearchHit[]>;

export interface SearchProviderErrorOptions {
  provider: string;
  status?: number;
  code?: string;
  retryAfter?: string;
  cause?: unknown;
}

export class SearchProviderError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfter: string | undefined;

  constructor(message: string, options: SearchProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SearchProviderError";
    this.provider = options.provider;
    this.status = options.status;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
  }
}
