import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcess } from "@agentcompose/sdk";
import type { TaskEvent } from "@agentcompose/sdk";
import { makeResearchAgent } from "../src/agent.ts";
import { fixtureProvider } from "../src/search/fixture.ts";
import { StubModel } from "./stub.ts";

function agent(over: { clarify?: boolean } = {}) {
  const a = makeResearchAgent({
    model: new StubModel({ angles: ["raft consensus"], section: "Body [1]." }),
    search: fixtureProvider([{ url: "https://x/raft", title: "Raft", content: "raft consensus leader" }]),
  });
  return a;
}

test("descriptor: injected mode advertises no secret-bearing config (runs without env)", () => {
  const a = agent();
  assert.equal(a.descriptor.id, "dev.agentcompose.research");
  assert.ok(a.descriptor.capabilities.some((c) => c.id === "research"));
  const props = (a.descriptor.configSchema as { properties: Record<string, unknown> }).properties;
  assert.ok(!("provider" in props), "no model provider in config when a model is injected");
  assert.ok(!("search" in props), "no search config when a search provider is injected");
  assert.ok("angles" in props && "clarify" in props);
});

test("end-to-end: submit → streamed events → completed with report + citations", async () => {
  const client = inProcess(agent());
  const task = await client.submit([{ kind: "text", text: "raft consensus" }]);

  const events: TaskEvent[] = [];
  for await (const ev of client.events(task.id)) {
    events.push(ev);
    if (ev.type === "result" || ev.type === "error") break;
  }

  const final = await client.get(task.id);
  assert.equal(final.state, "completed");
  assert.ok(events.some((e) => e.type === "message"), "streamed at least one message delta");
  assert.ok(events.some((e) => e.type === "progress"), "emitted progress");

  const parts = final.result?.parts ?? [];
  const textPart = parts.find((p) => p.kind === "text");
  const jsonPart = parts.find((p) => p.kind === "json");
  assert.ok(textPart && textPart.kind === "text" && /## Sources/.test(textPart.text), "report with sources");
  assert.ok(jsonPart && jsonPart.kind === "json", "structured citations part present");
  const payload = (jsonPart as { kind: "json"; json: { citations: unknown[]; angles: unknown[] } }).json;
  assert.ok(Array.isArray(payload.citations) && Array.isArray(payload.angles));

  await client.close();
});

test("HITL: clarify pauses in input-required, then resumes to completion", async () => {
  const client = inProcess(agent());
  await client.configure({ clarify: true });
  const task = await client.submit([{ kind: "text", text: "raft" }]);

  let asked = false;
  let provided = false;
  for await (const ev of client.events(task.id)) {
    if (ev.type === "status" && ev.state === "input-required" && !provided) {
      asked = true;
      provided = true;
      await client.provideInput(task.id, [{ kind: "text", text: "focus on safety guarantees" }]);
    }
    if (ev.type === "result" || ev.type === "error") break;
  }

  assert.ok(asked, "entered input-required (asked a clarifying question)");
  const final = await client.get(task.id);
  assert.equal(final.state, "completed");
  await client.close();
});
