// Shared test doubles. A scripted ModelClient (so the loop runs offline and
// deterministically) and a collecting emitter. Not a *.test.ts file, so the test
// runner won't execute it directly.
import type { ChatMessage, ChatOptions, ModelClient } from "../src/model.ts";
import type { ResearchEmitter } from "../src/types.ts";

export interface GatherStep {
  sufficient: boolean;
  nextQuery?: string;
}

export class StubModel implements ModelClient {
  readonly id = "stub";
  calls = { angles: 0, gather: 0, chat: 0 };
  #angles: string[];
  #gather: GatherStep[];
  #section: string;

  constructor(o: { angles?: string[]; gather?: GatherStep[]; section?: string } = {}) {
    this.#angles = o.angles ?? ["Angle one"];
    this.#gather = o.gather ?? [];
    this.#section = o.section ?? "Synthesized section [1].";
  }

  async json<T>(messages: ChatMessage[], _schema: object, opts: ChatOptions & { schemaName?: string } = {}): Promise<T> {
    if (opts.schemaName === "angles") {
      this.calls.angles++;
      return { angles: this.#angles.map((question) => ({ question })) } as T;
    }
    if (opts.schemaName === "gather") {
      const i = this.calls.gather++;
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const citations = [...user.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      const step = this.#gather[i] ?? { sufficient: true };
      return {
        notes: citations.map((citation) => ({ claim: `claim ${citation}`, citation })),
        sufficient: step.sufficient,
        nextQuery: step.nextQuery ?? "",
      } as T;
    }
    return {} as T;
  }

  async chat(_messages: ChatMessage[], _opts?: ChatOptions): Promise<string> {
    this.calls.chat++;
    return this.#section;
  }
}

export function collectingEmitter(): { emit: ResearchEmitter; state: { text: string; progress: [number, string][] } } {
  const state = { text: "", progress: [] as [number, string][] };
  const emit: ResearchEmitter = {
    progress: (percent, message) => state.progress.push([percent, message]),
    delta: (text) => {
      state.text += text;
    },
  };
  return { emit, state };
}
