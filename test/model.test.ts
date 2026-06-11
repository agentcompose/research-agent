// Unit tests for the OpenAI-compatible model client's structured `json()` call —
// specifically the one-shot reformat retry that recovers when a gateway/model
// ignores `json_schema` and answers a list-style prompt in prose. Stubs global
// fetch so no network is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openAIModel, parseJsonLoose } from "../src/model.ts";

function fakeFetch(bodies: string[]) {
  let i = 0;
  const calls: string[] = [];
  const fn = async (_url: string, init: { body: string }) => {
    calls.push(init.body);
    const content = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  };
  return { fn, calls: () => calls, count: () => i };
}

const model = () =>
  openAIModel({ baseUrl: "http://x/v1", apiKey: "k", model: "m" });
const SCHEMA = { type: "object", required: ["angles"] };

test("json(): parses valid JSON on the first try (no retry)", async () => {
  const f = fakeFetch(['{"angles":[{"question":"a"},{"question":"b"}]}']);
  const orig = globalThis.fetch;
  globalThis.fetch = f.fn as typeof fetch;
  try {
    const out = await model().json<{ angles: { question: string }[] }>([], SCHEMA, { schemaName: "angles" });
    assert.equal(out.angles.length, 2);
    assert.equal(f.count(), 1, "should not retry when first response parses");
  } finally {
    globalThis.fetch = orig;
  }
});

test("json(): retries once with a JSON-only reformat when the model answers in prose", async () => {
  // First response is a markdown numbered list (the real-world failure); second is JSON.
  const prose = "1. What are the fundamentals?\n2. What are the alternatives?\n3. What are the risks?";
  const json = '{"angles":[{"question":"fundamentals"},{"question":"alternatives"},{"question":"risks"}]}';
  const f = fakeFetch([prose, json]);
  const orig = globalThis.fetch;
  globalThis.fetch = f.fn as typeof fetch;
  try {
    const out = await model().json<{ angles: { question: string }[] }>(
      [{ role: "system", content: "plan" }, { role: "user", content: "topic" }],
      SCHEMA,
      { schemaName: "angles" },
    );
    assert.equal(out.angles.length, 3, "recovers all angles via retry instead of collapsing");
    assert.equal(f.count(), 2, "should retry exactly once");
    // The retry must carry a forceful JSON-only instruction and the schema inline.
    const retryBody = f.calls()[1];
    assert.match(retryBody, /ONLY a single JSON object/);
    assert.match(retryBody, /JSON Schema/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("json(): throws if even the retry is not JSON", async () => {
  const f = fakeFetch(["still prose", "more prose, no json"]);
  const orig = globalThis.fetch;
  globalThis.fetch = f.fn as typeof fetch;
  try {
    await assert.rejects(() => model().json([], SCHEMA), /did not return JSON/);
    assert.equal(f.count(), 2, "tries the original call then one reformat retry");
  } finally {
    globalThis.fetch = orig;
  }
});

test("parseJsonLoose: tolerates code fences and surrounding prose", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go: {"a":1} done'), { a: 1 });
});
