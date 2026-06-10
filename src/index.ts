// @agentcompose/research-agent — a configurable, spec-compliant research worker.
//
// Primary entry: build the agent and register it with any AgentCompose host.
//   import { makeResearchAgent } from "@agentcompose/research-agent";
//   const research = makeResearchAgent({ defaults: { baseUrl, model } });
//
// The internals (research loop, model client, search ports) are exported too, so the
// worker can be embedded, tested with stubs, or pointed at a different backend.
export { makeResearchAgent } from "./agent.ts";
export type { ResearchAgentOptions } from "./agent.ts";

export { research } from "./loop.ts";
export type { ResearchDeps } from "./loop.ts";

export { openAIModel, parseJsonLoose } from "./model.ts";
export type { ModelClient, ChatMessage, ChatOptions, OpenAIModelOptions } from "./model.ts";

export { tavily } from "./search/tavily.ts";
export type { TavilyOptions } from "./search/tavily.ts";
export { fixtureProvider } from "./search/fixture.ts";
export type { SearchProvider, SearchQuery, SearchResult } from "./search/provider.ts";

export type {
  ResearchConfig,
  ResearchResult,
  ResearchEmitter,
  Angle,
  Citation,
  Note,
  AngleFindings,
} from "./types.ts";
