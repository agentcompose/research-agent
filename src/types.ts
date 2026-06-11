// Domain types for the research worker. These describe the worker's *internal*
// orchestration state (angles, evidence, citations) and its output — kept separate
// from the AgentCompose wire types, which the agent surface (agent.ts) maps to.

/** Tunable behaviour of the research loop (mirrors the agent's configSchema). */
export interface ResearchConfig {
  /** Maximum distinct angles/sub-questions to investigate. */
  angles: number;
  /** Max sources to pull per search within an angle. */
  maxSourcesPerAngle: number;
  /** Max search→read→reflect iterations before moving on from an angle. */
  maxIterationsPerAngle: number;
  /** Distinct sources that count as "enough" to stop investigating an angle. */
  minSourcesForCoverage: number;
  /** Restrict retrieval to these domains when set. */
  includeDomains?: string[];
}

export interface Angle {
  question: string;
}

/** A cited source, numbered in first-seen order across the whole run. */
export interface Citation {
  id: number;
  url: string;
  title: string;
}

/** An atomic claim extracted from a source, tagged with the source's citation id. */
export interface Note {
  claim: string;
  citation: number;
}

export interface AngleFindings {
  question: string;
  notes: Note[];
  /** Distinct sources consulted for this angle. */
  sourceCount: number;
}

export interface ResearchResult {
  /** The final markdown report (with inline [n] citations and a Sources section). */
  report: string;
  citations: Citation[];
  angles: string[];
}

/** Side-channel for streamed progress + incremental report text. */
/** A minimal observability span surface, a structural subset of the SDK's SpanHandle.
 *  Declared locally so the research loop need not import the SDK to be traced. */
export interface ResearchSpan {
  attr(key: string, value: string | number | boolean): unknown;
  event(name: string, attributes?: Record<string, string | number | boolean>): unknown;
}

export interface ResearchEmitter {
  progress(percent: number, message: string): void;
  delta(text: string): void;
  /** Open a domain span around a unit of work (plan, search, synthesis). Optional: when
   *  absent — e.g. in offline unit tests — the loop runs identically with no tracing. */
  span?<T>(
    opts: { name: string; kind?: string; attributes?: Record<string, string | number | boolean> },
    fn: (span: ResearchSpan) => Promise<T>,
  ): Promise<T>;
}
