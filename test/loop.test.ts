import { test } from "node:test";
import assert from "node:assert/strict";
import { research } from "../src/loop.ts";
import { fixtureProvider } from "../src/search/fixture.ts";
import type { SearchResult } from "../src/search/provider.ts";
import type { ResearchConfig } from "../src/types.ts";
import { StubModel, collectingEmitter } from "./stub.ts";

const cfg = (over: Partial<ResearchConfig> = {}): ResearchConfig => ({
  angles: 4,
  maxSourcesPerAngle: 5,
  maxIterationsPerAngle: 2,
  minSourcesForCoverage: 3,
  ...over,
});

const docs = (...d: SearchResult[]) => d;

test("happy path: produces a cited report with a section per angle and a sources list", async () => {
  const search = fixtureProvider(
    docs(
      { url: "https://x/raft", title: "Raft", content: "raft consensus leader election" },
      { url: "https://x/paxos", title: "Paxos", content: "paxos consensus" },
    ),
  );
  const model = new StubModel({ angles: ["raft consensus", "paxos consensus"], section: "Body [1]." });
  const { emit, state } = collectingEmitter();

  const result = await research("consensus algorithms", cfg(), { model, search, emit });

  assert.match(result.report, /^# Research: consensus algorithms/);
  assert.ok(result.angles.length === 2);
  for (const a of result.angles) assert.ok(result.report.includes(`## ${a}`), `report has section for ${a}`);
  assert.ok(result.citations.length >= 1, "has citations");
  assert.match(result.report, /## Sources/);
  assert.equal(state.text, result.report, "streamed deltas reconstruct the full report");
  assert.ok(state.progress.at(-1)?.[0] === 100, "ends at 100% progress");
});

test("dedup: the same URL across angles gets one citation id", async () => {
  // One doc both angles will retrieve.
  const search = fixtureProvider(docs({ url: "https://x/only", title: "Only", content: "raft leader consensus" }));
  const model = new StubModel({ angles: ["raft", "raft leader"] });
  const { emit } = collectingEmitter();

  const result = await research("raft", cfg({ minSourcesForCoverage: 99 }), { model, search, emit });

  const urls = result.citations.map((c) => c.url);
  assert.equal(new Set(urls).size, urls.length, "no duplicate URLs in citations");
  assert.equal(result.citations.length, 1, "single source deduped to one citation");
});

test("novelty exhaustion: stops the angle when a reformulated query returns only seen sources", async () => {
  const search = fixtureProvider(docs({ url: "https://x/doc", title: "Doc", content: "raft leader election log" }));
  // Ask for more (insufficient) and reformulate to a query that hits the same doc.
  const model = new StubModel({ angles: ["raft"], gather: [{ sufficient: false, nextQuery: "leader" }] });
  const { emit } = collectingEmitter();

  const result = await research("raft", cfg({ maxIterationsPerAngle: 3, minSourcesForCoverage: 99 }), {
    model,
    search,
    emit,
  });

  assert.equal(model.calls.gather, 1, "second iteration found no fresh sources, so gather ran once");
  assert.equal(result.citations.length, 1);
});

test("reformulation: an insufficient angle reformulates and pulls a new source", async () => {
  const search = fixtureProvider(
    docs(
      { url: "https://x/raft", title: "Raft", content: "raft leader election" },
      { url: "https://x/paxos", title: "Paxos", content: "paxos quorum" },
    ),
  );
  const model = new StubModel({
    angles: ["raft"],
    gather: [
      { sufficient: false, nextQuery: "paxos" }, // iter 0: not enough → look at paxos
      { sufficient: true }, // iter 1: now satisfied
    ],
  });
  const { emit } = collectingEmitter();

  const result = await research("consensus", cfg({ maxIterationsPerAngle: 3, minSourcesForCoverage: 99 }), {
    model,
    search,
    emit,
  });

  assert.equal(model.calls.gather, 2, "ran two gather iterations");
  assert.equal(result.citations.length, 2, "picked up the reformulated source");
  assert.deepEqual(
    result.citations.map((c) => c.id),
    [1, 2],
    "citations numbered in first-seen order",
  );
});

test("no sources: synthesizes a graceful section without inventing citations", async () => {
  const search = fixtureProvider(docs({ url: "https://x/unrelated", title: "Unrelated", content: "quantum biology" }));
  const model = new StubModel({ angles: ["raft consensus"] }); // query won't match the corpus
  const { emit } = collectingEmitter();

  const result = await research("raft", cfg(), { model, search, emit });

  assert.equal(result.citations.length, 0, "no citations when nothing matched");
  assert.match(result.report, /No sufficient sources/);
});
