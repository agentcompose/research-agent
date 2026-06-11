// A small, self-contained model client. The research worker is SDK-only and must not
// depend on the engine's model adapter, so it carries its own OpenAI-compatible chat
// caller (raw fetch, SSE-aware). It exposes two operations the loop needs: free-form
// `chat` (synthesis) and `json` (structured planning/reflection), behind a `ModelClient`
// interface so tests inject a deterministic stub instead of a network call.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  temperature?: number;
}

/** The model surface the research loop depends on. Stub it in tests. */
export interface ModelClient {
  readonly id: string;
  /** Free-form completion returning text. */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  /**
   * Structured completion: instruct the model to emit JSON conforming to `schema`
   * and return it parsed. Implementations should request `json_schema` response
   * format where supported and defensively parse the result.
   */
  json<T>(messages: ChatMessage[], schema: object, opts?: ChatOptions & { schemaName?: string }): Promise<T>;
}

export interface OpenAIModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Extract assistant text from either a JSON chat-completions body or an SSE stream. */
function readContent(contentType: string, raw: string): string {
  if (contentType.includes("text/event-stream") || /^\s*data:/.test(raw)) {
    let out = "";
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        out += j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? "";
      } catch {
        // ignore keep-alive / non-JSON lines
      }
    }
    return out;
  }
  const data = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

/** Best-effort parse of model output as JSON: tolerate ```json fences and surrounding prose. */
export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // strip code fences
    const fenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    try {
      return JSON.parse(fenced) as T;
    } catch {
      // last resort: first balanced object/array span
      const start = fenced.search(/[[{]/);
      const end = Math.max(fenced.lastIndexOf("}"), fenced.lastIndexOf("]"));
      if (start >= 0 && end > start) return JSON.parse(fenced.slice(start, end + 1)) as T;
      throw new Error(`Model did not return JSON. Got: ${trimmed.slice(0, 200)}`);
    }
  }
}

/** An OpenAI-compatible chat model over raw fetch. Works with gateways that stream by default. */
export function openAIModel(opts: OpenAIModelOptions): ModelClient {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` };

  async function call(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Model HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }
    return readContent(res.headers.get("content-type") ?? "", await res.text());
  }

  return {
    id: `openai:${opts.model}`,
    async chat(messages, o = {}) {
      return call({ model: opts.model, messages, temperature: o.temperature ?? 0.3 }, o.signal);
    },
    async json<T>(messages: ChatMessage[], schema: object, o: ChatOptions & { schemaName?: string } = {}) {
      const body = {
        model: opts.model,
        messages,
        temperature: o.temperature ?? 0,
        response_format: {
          type: "json_schema",
          json_schema: { name: o.schemaName ?? "result", schema, strict: true },
        },
      };
      const first = await call(body, o.signal);
      try {
        return parseJsonLoose<T>(first);
      } catch {
        // Some gateways/models ignore `json_schema` for open-ended, list-style prompts
        // and answer in prose (e.g. a markdown numbered list). Retry once with a
        // forceful, prompt-level JSON-only instruction and the schema inline — which
        // these models honor reliably — instead of collapsing to a degraded fallback.
        const reformat: ChatMessage[] = [
          ...messages,
          {
            role: "user",
            content:
              "Output ONLY a single JSON object that conforms exactly to this JSON Schema. " +
              "No prose, no markdown, no code fences, no numbering.\n\nJSON Schema:\n" +
              JSON.stringify(schema),
          },
        ];
        const second = await call({ model: opts.model, messages: reformat, temperature: 0 }, o.signal);
        return parseJsonLoose<T>(second);
      }
    },
  };
}
