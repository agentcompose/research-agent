# @agentcompose/research-agent

A configurable, spec-compliant **research worker** for [AgentCompose](https://agentcompose.dev). Give it a topic; it investigates across multiple angles — fundamentals, alternatives, concerns, prior art — and returns a **cited report**.

> Status: pre-release (`0.1.0`, not yet on npm). Built on [`@agentcompose/sdk`](https://www.npmjs.com/package/@agentcompose/sdk).

It is a **leaf worker**, authored with the SDK only — no engine dependency. It owns its own research loop and treats retrieval and reasoning as swappable ports, so it runs standalone, over stdio, or as a worker an AgentCompose engine delegates to.

## What it does

A bounded, adaptive loop — the part worth keeping in-house:

```
Plan → Search → Read → Reflect → (reformulate / iterate) → Synthesize
```

- **Plan** — decompose the topic into distinct angles (questions).
- **Per angle** — search a real backend, dedupe sources by URL, extract cited claims, and **reflect**: is coverage met (≥ N independent sources) or has novelty run out? If not, **reformulate** the query and iterate.
- **Synthesize** — write one section per angle citing every statement, then a Sources list. Progress and report text are **streamed**.

The research-specific control logic (angle decomposition, coverage/novelty stopping, reformulation, citation tracking) lives here in the worker — deliberately **not** in a general orchestrator.

## Install

```bash
npm install @agentcompose/research-agent   # once published
```

## Quickstart

```ts
import { makeResearchAgent } from "@agentcompose/research-agent";
import { inProcess } from "@agentcompose/sdk";

// BYO-model via config (apiKey resolved from env as a SecretRef); Tavily key optional.
const research = makeResearchAgent({
  defaults: { baseUrl: "http://localhost:20128/v1", model: "gemini/gemini-3.1-flash-lite-preview" },
});

const client = inProcess(research);
const task = await client.submit([{ kind: "text", text: "Raft vs Paxos for a write-heavy service" }]);
for await (const ev of client.events(task.id)) {
  if (ev.type === "message" && ev.delta.kind === "text") process.stdout.write(ev.delta.text);
  if (ev.type === "result") break;
}
```

Or register it with an AgentCompose engine and let the master delegate to it — same descriptor, the consumer can't tell a leaf from a team.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `provider` | OpenAI-compatible | BYO-model gateway for planning/reflection/synthesis (`apiKey` via SecretRef). Omitted when a model is injected. |
| `search` | `{ kind: "tavily" }` | Retrieval backend. Configure an `apiKey` (a resolved string) to use Tavily; otherwise the offline fixture is used. Omitted when a search provider is injected. |
| `angles` | `4` | Max distinct angles to investigate. |
| `maxSourcesPerAngle` | `5` | Max sources pulled per search. |
| `maxIterationsPerAngle` | `2` | Max search→read→reflect cycles per angle. |
| `minSourcesForCoverage` | `3` | Distinct sources that count as "enough" for an angle. |
| `includeDomains` | — | Restrict retrieval to these domains. |
| `clarify` | `false` | Ask one scoping question via `input-required` first. Works standalone; nested HITL through a composing engine is not yet propagated. |

## Search backends

Retrieval is a port (`SearchProvider`). Two implementations ship:

- **`tavily`** — wraps [Tavily](https://tavily.com), which returns extracted, readable content (no HTML scraping). Bring an API key.
- **`fixtureProvider`** — a deterministic, offline backend over an in-memory corpus, so the whole loop runs with **no key and no network** (used in tests and as the keyless fallback).

```ts
import { makeResearchAgent, tavily, fixtureProvider } from "@agentcompose/research-agent";

makeResearchAgent({ search: tavily({ apiKey: process.env.TAVILY_API_KEY! }) });
makeResearchAgent({ search: fixtureProvider(myCorpus) }); // offline / tests
```

## Swappable internals

Because the worker is spec-compliant, its **descriptor is the same regardless of internals**. You can start with this from-scratch loop and later swap to a heavier engine (e.g. a deep-research service) behind the same descriptor — nothing upstream notices. The loop, model client, and search ports are all exported for embedding, testing, and replacement.

## License

[Apache-2.0](./LICENSE)
