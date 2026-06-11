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

### Fixed
- **Planner no longer collapses to a single angle, across model gateways.** The
  structured `json()` call could fail or degrade on gateways that don't honor
  `response_format: json_schema` — some answer list-style prompts in prose (Gemini via
  LiteLLM), and some reject the request, return valid JSON with *different* property
  names, or stream empty content (Claude via LiteLLM). Any of these made planning fall
  back to one angle (the topic restated) and could empty the report. `json()` now
  requests `stream:false`, validates the parsed result against the schema's required
  keys, and on any failure (HTTP error, prose, or wrong shape) retries once without
  `response_format` using a forceful JSON-only prompt with the schema inline. Verified
  live against `gh/claude-opus-4.6` and `gemini-3.x`.

### Known limitations
- Angles are investigated **sequentially**; parallel fan-out is future work.
- `clarify` surfaces `input-required` that works standalone but is not yet propagated
  through a composing engine (nested HITL).
- No long-horizon context compression or a dedicated citation-verification pass yet.
