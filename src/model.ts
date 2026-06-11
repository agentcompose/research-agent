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
      // stream:false: we await the whole completion (the loop emits it itself), and some
      // gateways' SSE is unreliable for certain models (emits only [DONE], no content).
      return call({ model: opts.model, messages, temperature: o.temperature ?? 0.3, stream: false }, o.signal);
    },
    async json<T>(messages: ChatMessage[], schema: object, o: ChatOptions & { schemaName?: string } = {}) {
      // The parsed result must contain the schema's top-level required keys. Some
      // gateways accept `json_schema` but ignore the property names (e.g. returning
      // `{topic, sub_questions}` instead of `{angles:[...]}`) — valid JSON, wrong shape.
      const required: string[] = Array.isArray((schema as { required?: unknown }).required)
        ? ((schema as { required: string[] }).required)
        : [];
      const shapeOk = (v: unknown): boolean =>
        required.length === 0 ||
        (typeof v === "object" && v !== null && required.every((k) => k in (v as Record<string, unknown>)));
      const reformat = (): Promise<string> =>
        call(
          {
            model: opts.model,
            stream: false,
            temperature: 0,
            messages: [
              ...messages,
              {
                role: "user",
                content:
                  "Output ONLY a single JSON object that conforms exactly to this JSON Schema. " +
                  "Use exactly these property names. No prose, no markdown, no code fences.\n\nJSON Schema:\n" +
                  JSON.stringify(schema),
              },
            ],
          },
          o.signal,
        );
      try {
        // Preferred path: native structured output via `json_schema` (honored by e.g.
        // OpenAI / Gemini). Accept it only if it parses AND has the required shape.
        const parsed = parseJsonLoose<T>(
          await call(
            {
              model: opts.model,
              messages,
              stream: false,
              temperature: o.temperature ?? 0,
              response_format: {
                type: "json_schema",
                json_schema: { name: o.schemaName ?? "result", schema, strict: true },
              },
            },
            o.signal,
          ),
        );
        if (shapeOk(parsed)) return parsed;
      } catch {
        // HTTP error (gateway rejects response_format) or unparseable prose — fall through.
      }
      // Cross-gateway fallback: no `response_format`, a forceful JSON-only instruction,
      // and the schema inline. Recovers the correct result instead of a degraded one.
      return parseJsonLoose<T>(await reformat());
    },
  };
}
