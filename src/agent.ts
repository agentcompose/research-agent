// The AgentCompose surface for the research worker. This is the thin adapter layer:
// it declares the public configuration surface (descriptor + configSchema), maps the
// task lifecycle (goal in → streamed progress/deltas → cited result out, with an
// optional input-required clarification), and delegates all the actual work to the
// in-house research loop over injected ports. Authored with the SDK only — no engine
// dependency, so this worker is an independent, swappable component.
import { defineAgent, AgentError, ErrorCodes } from "@agentcompose/sdk";
import type { AgentDefinition, Part } from "@agentcompose/sdk";
import { openAIModel } from "./model.ts";
import type { ModelClient } from "./model.ts";
import { tavily } from "./search/tavily.ts";
import { fixtureProvider } from "./search/fixture.ts";
import type { SearchProvider } from "./search/provider.ts";
import { research } from "./loop.ts";
import type { ResearchConfig, ResearchEmitter } from "./types.ts";

export interface ResearchAgentOptions {
  /** Defaults baked into the configSchema (the gateway the worker calls by default). */
  defaults?: {
    baseUrl?: string;
    model?: string;
    angles?: number;
    maxSourcesPerAngle?: number;
    maxIterationsPerAngle?: number;
    minSourcesForCoverage?: number;
  };
  /**
   * Inject a ready ModelClient (skips config-based construction). Primarily for tests
   * and embedding; production wiring leaves this unset and supplies a provider via config.
   */
  model?: ModelClient;
  /** Inject a ready SearchProvider (skips config-based construction). For tests/embedding. */
  search?: SearchProvider;
}

function toText(parts: Part[]): string {
  return parts
    .map((p) => (p.kind === "text" ? p.text : p.kind === "json" ? JSON.stringify(p.json) : ""))
    .join("\n")
    .trim();
}
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

interface ProviderConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}
interface SearchConfig {
  kind?: string;
  apiKey?: string;
}

/** Build the search backend from config, falling back to the offline fixture when no key. */
function buildSearch(cfg: SearchConfig | undefined): SearchProvider {
  if (cfg?.kind === "tavily" && cfg.apiKey) return tavily({ apiKey: cfg.apiKey });
  // No usable key → deterministic offline provider, so the agent still runs (keyless demo).
  return fixtureProvider();
}

/** Build the research worker. Pass your gateway defaults; secrets resolve from env via SecretRef. */
export function makeResearchAgent(opts: ResearchAgentOptions = {}): AgentDefinition {
  const d = opts.defaults ?? {};
  // The config surface is conditional on injection. A baked SecretRef is resolved
  // eagerly (and throws if unset), so we only advertise the model provider when the
  // worker must source its own model — and never bake a mandatory search key, because
  // search is optional (it falls back to the offline fixture).
  const properties: Record<string, unknown> = {
    angles: { type: "number", minimum: 1, maximum: 8, default: d.angles ?? 4 },
    maxSourcesPerAngle: { type: "number", minimum: 1, maximum: 15, default: d.maxSourcesPerAngle ?? 5 },
    maxIterationsPerAngle: { type: "number", minimum: 1, maximum: 5, default: d.maxIterationsPerAngle ?? 2 },
    minSourcesForCoverage: { type: "number", minimum: 1, maximum: 20, default: d.minSourcesForCoverage ?? 3 },
    includeDomains: {
      type: "array",
      items: { type: "string" },
      description: "Restrict retrieval to these domains (e.g. arxiv.org).",
    },
    clarify: {
      type: "boolean",
      default: false,
      description:
        "Ask one scoping question via input-required before researching. Works standalone and through a composing engine (the engine escalates it to its controller / a human).",
    },
  };
  if (!opts.model) {
    properties.provider = {
      type: "object",
      description: "BYO-model: the OpenAI-compatible gateway used for planning, reflection, and synthesis.",
      default: {
        kind: "openai",
        baseUrl: d.baseUrl ?? "https://api.openai.com/v1",
        model: d.model ?? "gpt-4o-mini",
        apiKey: { secretRef: "OPENAI_API_KEY" },
      },
    };
  }
  if (!opts.search) {
    // Optional: configure an apiKey (a resolved string) to use Tavily; otherwise the
    // worker uses the offline fixture provider. Intentionally not a mandatory SecretRef.
    properties.search = {
      type: "object",
      description: "Retrieval backend. Tavily when an apiKey is configured; an offline fixture otherwise.",
      default: { kind: "tavily" },
    };
  }
  return defineAgent({
    descriptor: {
      id: "dev.agentcompose.research",
      name: "Research",
      version: "0.1.0",
      description:
        "Investigates a topic across multiple angles (fundamentals, alternatives, concerns, prior art) and produces a cited report.",
      capabilities: [
        { id: "research", description: "Research a topic across multiple angles and produce a cited, sourced report." },
      ],
      configSchema: {
        type: "object",
        additionalProperties: true,
        properties,
      },
    },
    async handle(goal, ctx) {
      let topic = toText(goal);
      if (!topic) throw new AgentError(ErrorCodes.InvalidGoal, "No research topic was provided.");

      const cfg = ctx.config as Record<string, unknown>;
      const provider = (cfg.provider ?? {}) as ProviderConfig;
      const model =
        opts.model ??
        openAIModel({
          baseUrl: provider.baseUrl ?? "https://api.openai.com/v1",
          apiKey: provider.apiKey ?? "",
          model: provider.model ?? "gpt-4o-mini",
        });
      const search = opts.search ?? buildSearch(cfg.search as SearchConfig | undefined);

      const config: ResearchConfig = {
        angles: num(cfg.angles, 4),
        maxSourcesPerAngle: num(cfg.maxSourcesPerAngle, 5),
        maxIterationsPerAngle: num(cfg.maxIterationsPerAngle, 2),
        minSourcesForCoverage: num(cfg.minSourcesForCoverage, 3),
        includeDomains: Array.isArray(cfg.includeDomains) ? cfg.includeDomains.map(String) : undefined,
      };

      // Optional HITL clarification round (the spec's input-required state).
      if (cfg.clarify === true) {
        const question = await model
          .chat(
            [
              { role: "system", content: "Ask exactly one concise question to scope the research. Output only the question." },
              { role: "user", content: `Topic: ${topic}` },
            ],
            { signal: ctx.signal },
          )
          .catch(() => "What scope, depth, or constraints should this research focus on?");
        const answer = await ctx.requestInput([{ kind: "text", text: question.trim() }]);
        const ans = toText(answer);
        if (ans) topic = `${topic}\n\nScope/clarification: ${ans}`;
      }

      const emit: ResearchEmitter = {
        progress: (percent, message) => ctx.progress(percent, message),
        delta: (text) => ctx.message({ kind: "text", text }),
        span: (opts, fn) => ctx.trace.span(opts, fn),
      };

      const result = await research(topic, config, { model, search, emit, signal: ctx.signal });

      ctx.artifact([{ kind: "text", text: result.report }], "report.md");
      return [
        { kind: "text", text: result.report },
        { kind: "json", json: { citations: result.citations, angles: result.angles } },
      ];
    },
  });
}
