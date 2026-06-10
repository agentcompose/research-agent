# Changelog

All notable changes to `@agentcompose/research-agent` are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org).

## [0.1.0] - Unreleased

First release: a configurable, spec-compliant research worker (SDK-only).

### Added
- **Adaptive research loop** — Plan → Search → Read → Reflect → Iterate → Synthesize,
  with angle decomposition, per-angle coverage/novelty stopping, query reformulation,
  URL dedup, first-seen citation tracking, and section-aware streamed synthesis.
- **Pluggable retrieval** (`SearchProvider` port): a **Tavily** adapter (extracted
  content, no scraping) and a deterministic **fixture** provider for offline/keyless runs.
- **Self-contained model client** — OpenAI-compatible chat (SSE-aware) with a
  structured-output helper; no engine dependency.
- **AgentCompose surface** — `makeResearchAgent()` with a typed `configSchema`
  (model provider, search backend, angles, source/iteration budgets, domain filter,
  clarify), streamed progress + message deltas, a `report.md` artifact, and a result
  carrying the markdown report plus structured citations.
- **Optional HITL clarification** via the spec's `input-required` state.
- Exports of the loop, model client, and search ports for embedding and testing.

### Known limitations
- Angles are investigated **sequentially**; parallel fan-out is future work.
- `clarify` surfaces `input-required` that works standalone but is not yet propagated
  through a composing engine (nested HITL).
- No long-horizon context compression or a dedicated citation-verification pass yet.
