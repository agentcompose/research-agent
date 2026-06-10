// The search seam. The research worker owns its adaptive loop but treats *retrieval*
// as a pluggable capability: a SearchProvider turns a query into ranked results with
// already-extracted readable content. Wrapping a mature, purpose-built search-and-extract
// service (Tavily) is the right altitude — we never write an HTML scraper. A fixture
// provider implements the same port so the entire loop is exercisable with no API key.

/** One retrieved source: a URL, its title, and extracted readable content (not raw HTML). */
export interface SearchResult {
  url: string;
  title: string;
  /** Readable, extracted content for this source (already stripped of markup). */
  content: string;
  /** Provider relevance score in [0,1] when available; used only as a tie-breaker. */
  score?: number;
  /** ISO date the source was published, when the provider reports it. */
  publishedAt?: string;
}

export interface SearchQuery {
  query: string;
  /** Max results to return. Providers may return fewer. */
  maxResults: number;
  /** Restrict to these domains when set (e.g. ["arxiv.org", "nature.com"]). */
  includeDomains?: string[];
  /** Abort signal so a long retrieval is cancelled with the task. */
  signal?: AbortSignal;
}

/**
 * A retrieval backend. The only contract: given a query, return results whose
 * `content` is readable text (caller does not parse HTML). Implementations wrap a
 * real search-and-extract service; the worker depends on this interface, not on any
 * particular vendor — so the backend is swappable and tests use a fixture.
 */
export interface SearchProvider {
  /** Stable identifier for logging/telemetry (e.g. "tavily", "fixture"). */
  readonly id: string;
  search(query: SearchQuery): Promise<SearchResult[]>;
}
