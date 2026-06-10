// The research loop — the worker's own domain orchestration. This is deliberately the
// part we keep in-house: a bounded, adaptive Plan → Search → Read → Reflect → Iterate →
// Synthesize cycle. It owns the *research-specific* control logic (angle decomposition,
// coverage/novelty stopping, query reformulation, citation tracking, section-aware
// synthesis) — none of which belongs in a general orchestrator. Retrieval and reasoning
// are delegated to injected ports (SearchProvider, ModelClient), so the loop is fully
// testable offline and the backends are swappable.
import type { ModelClient } from "./model.ts";
import type { SearchProvider } from "./search/provider.ts";
import type { Angle, AngleFindings, Citation, Note, ResearchConfig, ResearchEmitter, ResearchResult } from "./types.ts";

export interface ResearchDeps {
  model: ModelClient;
  search: SearchProvider;
  emit: ResearchEmitter;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Research aborted");
}

/** First-seen-ordered citation registry; dedupes sources by URL across the whole run. */
class CitationBook {
  #byUrl = new Map<string, Citation>();
  #list: Citation[] = [];
  ref(url: string, title: string): number {
    const existing = this.#byUrl.get(url);
    if (existing) return existing.id;
    const citation: Citation = { id: this.#list.length + 1, url, title };
    this.#byUrl.set(url, citation);
    this.#list.push(citation);
    return citation.id;
  }
  all(): Citation[] {
    return this.#list.slice();
  }
}

const ANGLES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["angles"],
  properties: {
    angles: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question"],
        properties: { question: { type: "string" } },
      },
    },
  },
} as const;

const GATHER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["notes", "sufficient", "nextQuery"],
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "citation"],
        properties: { claim: { type: "string" }, citation: { type: "number" } },
      },
    },
    sufficient: { type: "boolean" },
    nextQuery: { type: "string", description: "A better search query if more is needed; empty string if sufficient." },
  },
} as const;

/** Decompose the topic into distinct angles; falls back to the bare topic on failure. */
async function planAngles(topic: string, config: ResearchConfig, deps: ResearchDeps): Promise<Angle[]> {
  try {
    const out = await deps.model.json<{ angles: { question: string }[] }>(
      [
        {
          role: "system",
          content:
            "You are a research planner. Decompose the user's topic into distinct, non-overlapping angles " +
            "worth investigating — typically the underlying fundamentals, the main alternatives/comparisons, " +
            "the biggest concerns or risks, and notable prior art. Return each angle as a precise, specific " +
            "sub-question. Never restate the topic verbatim, and never return a single angle that merely " +
            "rephrases the whole topic — produce several genuinely different sub-questions.",
        },
        { role: "user", content: `Topic: ${topic}\n\nReturn ${config.angles} distinct sub-questions (at most ${config.angles}).` },
      ],
      ANGLES_SCHEMA,
      { signal: deps.signal, schemaName: "angles" },
    );
    const angles = (out.angles ?? [])
      .map((a) => ({ question: (a.question ?? "").trim() }))
      .filter((a) => a.question.length > 0)
      .slice(0, config.angles);
    if (angles.length > 0) return angles;
  } catch {
    // fall through to the single-angle fallback
  }
  return [{ question: topic }];
}

interface GatherOutcome {
  notes: Note[];
  sufficient: boolean;
  nextQuery: string;
}

/** Extract cited claims from new sources and judge sufficiency in one structured call. */
async function gather(
  question: string,
  priorNoteCount: number,
  newSources: { citation: number; title: string; content: string }[],
  deps: ResearchDeps,
): Promise<GatherOutcome> {
  const sourcesText = newSources
    .map((s) => `[${s.citation}] ${s.title}\n${s.content.slice(0, 1500)}`)
    .join("\n\n");
  try {
    const out = await deps.model.json<GatherOutcome>(
      [
        {
          role: "system",
          content:
            "Extract atomic, factual claims relevant to the question from the provided sources, each tagged " +
            "with its [citation] number. Use only the given sources; never invent claims or citation numbers. " +
            "Then judge whether the evidence so far sufficiently answers the question. If not, propose a better " +
            "search query in nextQuery; otherwise set nextQuery to an empty string.",
        },
        {
          role: "user",
          content: `Question: ${question}\n\n${priorNoteCount} claim(s) already collected.\n\nNew sources:\n${sourcesText}`,
        },
      ],
      GATHER_SCHEMA,
      { signal: deps.signal, schemaName: "gather" },
    );
    return {
      notes: (out.notes ?? []).filter((n) => Number.isInteger(n.citation) && typeof n.claim === "string"),
      sufficient: Boolean(out.sufficient),
      nextQuery: typeof out.nextQuery === "string" ? out.nextQuery : "",
    };
  } catch {
    // Resilient fallback: treat each new source's lead as a claim, keep going.
    return {
      notes: newSources.map((s) => ({ claim: s.content.slice(0, 200).trim(), citation: s.citation })),
      sufficient: false,
      nextQuery: "",
    };
  }
}

/** Write one report section from an angle's collected claims, citing each statement. */
async function writeSection(topic: string, findings: AngleFindings, deps: ResearchDeps): Promise<string> {
  if (findings.notes.length === 0) return "_No sufficient sources were found for this angle._";
  const claims = findings.notes.map((n) => `- ${n.claim} [${n.citation}]`).join("\n");
  return deps.model.chat(
    [
      {
        role: "system",
        content:
          "Write a concise, neutral section that answers the question using ONLY the provided claims. Cite every " +
          "statement with its [n] marker(s). Do not invent facts or citations. Where the evidence is thin or the " +
          "sources conflict, say so explicitly. Do NOT add a Sources, References, or bibliography list — that is " +
          "appended separately. Do not repeat the question as a heading.",
      },
      { role: "user", content: `Topic: ${topic}\nQuestion: ${findings.question}\n\nClaims:\n${claims}` },
    ],
    { signal: deps.signal, temperature: 0.2 },
  );
}

function renderSources(citations: Citation[]): string {
  if (citations.length === 0) return "## Sources\n\n_No sources were cited._\n";
  return "## Sources\n\n" + citations.map((c) => `${c.id}. [${c.title}](${c.url})`).join("\n") + "\n";
}

/**
 * Run the full research loop for a topic and return a cited report. Progress and
 * incremental report text are streamed through `deps.emit`.
 */
export async function research(
  topic: string,
  config: ResearchConfig,
  deps: ResearchDeps,
): Promise<ResearchResult> {
  const book = new CitationBook();

  deps.emit.progress(5, "Planning research angles…");
  const angles = await planAngles(topic, config, deps);
  deps.emit.progress(12, `Investigating ${angles.length} angle(s)`);

  const findings: AngleFindings[] = [];
  for (let ai = 0; ai < angles.length; ai++) {
    throwIfAborted(deps.signal);
    const question = angles[ai].question;
    const notes: Note[] = [];
    const seen = new Set<string>();
    let query = question;

    for (let it = 0; it < config.maxIterationsPerAngle; it++) {
      throwIfAborted(deps.signal);
      const base = 12 + Math.round((ai / angles.length) * 60);
      deps.emit.progress(base, `Angle ${ai + 1}/${angles.length}: searching…`);

      const results = await deps.search.search({
        query,
        maxResults: config.maxSourcesPerAngle,
        includeDomains: config.includeDomains,
        signal: deps.signal,
      });
      const fresh = results.filter((r) => !seen.has(r.url));
      if (fresh.length === 0) break; // novelty exhausted / weak query → stop this angle

      const withCites = fresh.map((r) => {
        seen.add(r.url);
        return { citation: book.ref(r.url, r.title), title: r.title, content: r.content };
      });

      const outcome = await gather(question, notes.length, withCites, deps);
      notes.push(...outcome.notes);

      if (outcome.sufficient || seen.size >= config.minSourcesForCoverage) break;
      const next = outcome.nextQuery.trim();
      if (next && next !== query) query = next; // reformulate and iterate
      else break; // no new direction → stop
    }

    findings.push({ question, notes, sourceCount: seen.size });
  }

  // Section-aware synthesis: write + stream one section per angle, then the sources.
  deps.emit.progress(80, "Writing report…");
  // The incoming topic can carry a planner-expanded restatement plus the original goal;
  // use the first non-empty line as a clean H1 title.
  const title = topic.split("\n").map((s) => s.trim()).find((s) => s.length > 0) ?? topic;
  const header = `# Research: ${title}\n\n`;
  let report = header;
  deps.emit.delta(header);

  const single = findings.length === 1;
  for (const f of findings) {
    throwIfAborted(deps.signal);
    const section = await writeSection(topic, f, deps);
    // With a single angle the per-angle heading just restates the title, so omit it.
    const block = single ? `${section}\n\n` : `## ${f.question}\n\n${section}\n\n`;
    report += block;
    deps.emit.delta(block);
  }

  const citations = book.all();
  const sources = renderSources(citations);
  report += sources;
  deps.emit.delta(sources);

  deps.emit.progress(100, "Done");
  return { report, citations, angles: angles.map((a) => a.question) };
}
