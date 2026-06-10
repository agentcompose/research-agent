// Tavily adapter for the SearchProvider port. Tavily is purpose-built for agents:
// a single call returns ranked results with extracted, readable content, so the worker
// skips a separate fetch+parse step entirely. We wrap it behind our own port so the
// rest of the worker never knows the vendor. Docs: https://docs.tavily.com
import type { SearchProvider, SearchQuery, SearchResult } from "./provider.ts";

export interface TavilyOptions {
  apiKey: string;
  /** Override endpoint (defaults to Tavily's public API). */
  endpoint?: string;
  /** "basic" (faster/cheaper) or "advanced" (deeper extraction). */
  depth?: "basic" | "advanced";
}

interface TavilyResponse {
  results?: { url?: string; title?: string; content?: string; raw_content?: string; score?: number; published_date?: string }[];
}

/** Wrap Tavily's search+extract API as a SearchProvider. */
export function tavily(opts: TavilyOptions): SearchProvider {
  const endpoint = opts.endpoint ?? "https://api.tavily.com/search";
  return {
    id: "tavily",
    async search(q: SearchQuery): Promise<SearchResult[]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          query: q.query,
          max_results: q.maxResults,
          search_depth: opts.depth ?? "advanced",
          include_raw_content: false,
          ...(q.includeDomains?.length ? { include_domains: q.includeDomains } : {}),
        }),
        signal: q.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Tavily HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as TavilyResponse;
      return (data.results ?? [])
        .filter((r): r is Required<Pick<typeof r, "url">> & typeof r => typeof r.url === "string")
        .map((r) => ({
          url: r.url as string,
          title: (r.title ?? r.url) as string,
          content: (r.content ?? r.raw_content ?? "").trim(),
          score: typeof r.score === "number" ? r.score : undefined,
          publishedAt: r.published_date,
        }))
        .filter((r) => r.content.length > 0);
    },
  };
}
