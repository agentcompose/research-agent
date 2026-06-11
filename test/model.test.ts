// Unit tests for the OpenAI-compatible model client's structured `json()` call and its
// cross-gateway resilience: it requests native `json_schema`, and on EITHER an HTTP
// error (gateway rejects `response_format`) OR a prose answer (gateway ignores it),
// retries once without `response_format` using a forceful JSON-only prompt. Also pins
// stream:false on requests (some gateways' SSE returns empty for certain models).
// Stubs global fetch so no network is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openAIModel, parseJsonLoose } from "../src/model.ts";

interface Resp { status?: number; content?: string; body?: string }
function fakeFetch(responses: Resp[]) {
  let i = 0;
  const bodies: string[] = [];
  const fn = async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    const status = r.status ?? 200;
    const text = r.body ?? JSON.stringify({ choices: [{ message: { content: r.content ?? "" } }] });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      text: async () => text,
    } as unknown as Response;
  };
  return { fn, bodies: () => bodies, count: () => i };
}

const model = () => openAIModel({ baseUrl: "http://x/v1", apiKey: "k", model: "m" });
const SCHEMA = { type: "object", required: ["angles"] };
const withFetch = async (f: ReturnType<typeof fakeFetch>, run: () => Promise<void>) => {
  const orig = globalThis.fetch;
  globalThis.fetch = f.fn as typeof fetch;
  try { await run(); } finally { globalThis.fetch = orig; }
};

test("json(): parses valid JSON on the first try (no retry)", async () => {
  const f = fakeFetch([{ content: '{"angles":[{"q":1},{"q":2}]}' }]);
  await withFetch(f, async () => {
    const out = await model().json<{ angles: unknown[] }>([], SCHEMA, { schemaName: "angles" });
    assert.equal(out.angles.length, 2);
    assert.equal(f.count(), 1, "should not retry when first response parses");
    assert.match(f.bodies()[0], /"stream":false/, "requests are non-streaming");
  });
});

test("json(): retries without response_format when the model answers in prose", async () => {
  const prose = "1. fundamentals\n2. alternatives\n3. risks";
  const json = '{"angles":[{"q":1},{"q":2},{"q":3}]}';
  const f = fakeFetch([{ content: prose }, { content: json }]);
  await withFetch(f, async () => {
    const out = await model().json<{ angles: unknown[] }>(
      [{ role: "system", content: "plan" }], SCHEMA, { schemaName: "angles" });
    assert.equal(out.angles.length, 3, "recovers via retry instead of throwing");
    assert.equal(f.count(), 2, "exactly one retry");
    const retry = f.bodies()[1];
    assert.match(retry, /ONLY a single JSON object/);
    assert.doesNotMatch(retry, /response_format/, "retry drops response_format");
  });
});

test("json(): retries when the json_schema request itself errors (HTTP 400)", async () => {
  // The gh/claude-via-LiteLLM case: response_format json_schema → 400 bad_request.
  const f = fakeFetch([{ status: 400, body: '{"error":{"message":"Invalid JSON body"}}' }, { content: '{"angles":[]}' }]);
  await withFetch(f, async () => {
    const out = await model().json<{ angles: unknown[] }>([], SCHEMA);
    assert.deepEqual(out.angles, [], "recovers after the json_schema request 400s");
    assert.equal(f.count(), 2, "first attempt 400s, retry succeeds");
    assert.doesNotMatch(f.bodies()[1], /response_format/);
  });
});

test("json(): throws if even the retry is not JSON", async () => {
  const f = fakeFetch([{ content: "still prose" }, { content: "" }]);
  await withFetch(f, async () => {
    await assert.rejects(() => model().json([], SCHEMA), /did not return JSON/);
    assert.equal(f.count(), 2);
  });
});

test("json(): retries when json_schema returns valid JSON of the WRONG shape", async () => {
  // gh/claude-via-LiteLLM with stream:false accepts json_schema but ignores property
  // names, e.g. returns {topic, sub_questions} instead of the required {angles}.
  const wrong = '{"topic":"x","sub_questions":["a","b"]}';
  const right = '{"angles":[{"q":1},{"q":2},{"q":3}]}';
  const f = fakeFetch([{ content: wrong }, { content: right }]);
  await withFetch(f, async () => {
    const out = await model().json<{ angles: unknown[] }>([], SCHEMA, { schemaName: "angles" });
    assert.equal(out.angles.length, 3, "reformat recovers the required shape");
    assert.equal(f.count(), 2, "wrong-shape result triggers exactly one retry");
  });
});

test("parseJsonLoose: tolerates code fences and surrounding prose", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go: {"a":1} done'), { a: 1 });
});
