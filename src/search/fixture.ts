// A deterministic, offline SearchProvider. It ranks a fixed in-memory corpus by naive
// keyword overlap so the entire research loop — planning, dedup, coverage/novelty
// stopping, citation tracking, synthesis — runs and is testable with no API key and no
// network. Tests inject their own corpus to drive specific scenarios; a small built-in
// corpus powers a keyless demo.
import type { SearchProvider, SearchQuery, SearchResult } from "./provider.ts";

const tokenize = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

function score(query: string, doc: SearchResult): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const hay = tokenize(`${doc.title} ${doc.content} ${doc.url}`);
  let hits = 0;
  for (const t of hay) if (q.has(t)) hits++;
  return hits;
}

/**
 * Build a fixture provider over a corpus. Results are ranked by keyword overlap with
 * the query and filtered by domain; ties broken by the corpus order, so output is
 * fully deterministic. Documents with zero overlap are excluded (so "novelty
 * exhaustion" and weak-query reformulation paths are reachable in tests).
 */
export function fixtureProvider(corpus: SearchResult[] = BUILTIN_CORPUS): SearchProvider {
  return {
    id: "fixture",
    async search(q: SearchQuery): Promise<SearchResult[]> {
      const allowed = q.includeDomains?.length
        ? corpus.filter((d) => q.includeDomains!.some((dom) => d.url.includes(dom)))
        : corpus;
      return allowed
        .map((doc, i) => ({ doc, i, s: score(q.query, doc) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, q.maxResults)
        .map((x) => x.doc);
    },
  };
}

/** Minimal built-in corpus for a keyless demo (intentionally small). */
const BUILTIN_CORPUS: SearchResult[] = [
  {
    url: "https://example.org/raft-consensus",
    title: "Raft: In Search of an Understandable Consensus Algorithm",
    content:
      "Raft is a consensus algorithm for managing a replicated log. It separates leader election, log replication, and safety, and is designed to be easier to understand than Paxos. A leader handles all client requests; if the leader fails, a new one is elected.",
  },
  {
    url: "https://example.org/paxos-made-simple",
    title: "Paxos Made Simple",
    content:
      "Paxos is a family of protocols for solving consensus in a network of unreliable processors. It is notoriously difficult to understand. Raft was later proposed as a more understandable alternative with equivalent fault tolerance.",
  },
  {
    url: "https://example.org/consensus-tradeoffs",
    title: "Trade-offs in Distributed Consensus",
    content:
      "Consensus algorithms trade latency, throughput, and availability. Leader-based protocols like Raft and Multi-Paxos reduce message delays but concentrate load on the leader, a concern for write-heavy workloads and a single point of contention.",
  },
];
