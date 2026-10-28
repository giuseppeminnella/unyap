import assert from "node:assert/strict";
import { it } from "node:test";
import type { Analysis, AnalysisProgress } from "../shared/types.ts";
import { runAnalysis } from "./analysis.ts";
import { createMockClient, ModelError, type DecisionsClient, type DecisionsResponse } from "./decisions.ts";
import { egg } from "./test-fixtures.ts";

const quiet = () => {};

/** Runs the analysis and collects its progress events; a rejection is returned as `error`, not thrown. */
async function trace(client: DecisionsClient, request = egg) {
  const events: AnalysisProgress[] = [];
  let analysis: Analysis | null = null;
  let error: unknown = null;
  try {
    analysis = await runAnalysis(client, request, (event) => events.push(event), quiet);
  } catch (caught) {
    error = caught;
  }
  return { events, analysis, error };
}

it("reports both calls in order, with counts and never the transcript", async () => {
  const { events, analysis } = await trace(createMockClient());
  assert.deepEqual(events.map((event) => event.type), ["prepared", "call-start", "call-end", "call-start", "call-end"]);
  assert.deepEqual(events.filter((event) => event.type === "call-start").map((event) => event.questions), [6, 1]);
  assert.equal(analysis?.payoff?.startMs, 31_000);
  const text = JSON.stringify(events);
  for (const line of egg.transcript) assert.ok(!text.includes(line.text));
});

it("reports a main-call failure and rejects", async () => {
  const { events, error } = await trace({
    ...createMockClient(),
    async decide() { throw new ModelError("network error"); },
  });
  assert.deepEqual(events.map((event) => event.type), ["prepared", "call-start", "call-error"]);
  assert.ok(error instanceof ModelError);
});

it("reports a refinement failure and still returns the coarse payoff", async () => {
  const { events, analysis } = await trace({
    ...createMockClient(),
    async refine() { throw new ModelError("timeout"); },
  });
  assert.deepEqual(events.map((event) => event.type), ["prepared", "call-start", "call-end", "call-start", "call-error"]);
  assert.equal(analysis?.payoff?.startMs, 30_000);
});

it("reports skipped refinement rather than inventing a second call", async () => {
  const { events } = await trace(createMockClient(), {
    ...egg, transcript: [{ startMs: 0, durationMs: 100_000, text: "Subscribe to our sponsor" }],
  });
  assert.deepEqual(events.map((event) => event.type), ["prepared", "call-start", "call-end", "refine-skipped"]);
});

it("reports a refused refinement as a response and keeps the coarse payoff", async () => {
  const mock = createMockClient();
  const { events, analysis } = await trace({
    ...mock,
    async refine(request, lines) {
      const response = await mock.refine(request, lines) as DecisionsResponse;
      return { ...response, answers: [{ type: "refusal", name: "start" }] };
    },
  });
  const refinement = events.find((event) => event.type === "call-end" && event.call === "refine");
  assert.ok(refinement?.type === "call-end" && refinement.refusals === 1);
  assert.ok(!events.some((event) => event.type === "call-error"));
  assert.equal(analysis?.payoff?.startMs, 30_000);
});
