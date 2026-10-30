import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapRefinement, mapResponse, runAnalysis } from "./analysis.ts";
import { isRecord } from "./guards.ts";
import { buildDecisionsRequest, buildRefinementRequest, ModelError, scoreName, segmentName } from "./decisions.ts";
import { createOpenRouterClient, fromOpenRouterResponse, toOpenRouterRequest } from "./openrouter.ts";
import { segmentTranscript } from "./segments.ts";
import { API_KEY, egg, eggRefinementLines, jsonResponse, stubFetch } from "./test-fixtures.ts";

const MODEL = "openai/gpt-6-luna-decisions";
const eggSegments = segmentTranscript(egg);
const eggRequest = buildDecisionsRequest(egg, eggSegments);
const eggRefinement = buildRefinementRequest(egg, eggRefinementLines);

/** An OpenRouter reply for egg, shaped like the example in OpenRouter's API reference: payoff at S2. */
function openRouterReply(): Record<string, unknown> {
  const answers: Record<string, unknown> = {
    delivers: { type: "noul", noul: 0.91 },
    payoff: {
      type: "choice",
      choice: "S2",
      confidence: 0.8,
      probabilities: { S1: 0.1, S2: 0.84, none: 0.06 },
    },
  };
  for (const segment of eggSegments) {
    const substance = segment.index === 1;
    answers[scoreName(segment.index)] = {
      type: "score",
      score: substance ? 1.9 : 0.1,
      confidence: 0.9,
      legend: { "0": "filler: …", "1": "context: …", "2": "substance: …" },
      probabilities: substance ? { "0": 0, "1": 0.1, "2": 0.9 } : { "0": 0.9, "1": 0.1, "2": 0 },
    };
  }
  return {
    id: "gen-dec-1",
    model: "openai/gpt-6-luna-decisions-20261006",
    provider: "OpenAI",
    answers,
    usage: { input_tokens: 476, output_tokens: 70, cost: 0.00002 },
  };
}

describe("toOpenRouterRequest", () => {
  it("sends the prompt as state and every question keyed by name", () => {
    const body = toOpenRouterRequest(eggRequest, MODEL);
    assert.equal(body.model, MODEL);
    assert.equal(body.state, eggRequest.input[0]?.content);
    assert.deepEqual(Object.keys(body.questions), eggRequest.questions.map((question) => question.name));
    assert.deepEqual(body.questions.delivers, {
      type: "noul",
      instructions: eggRequest.questions[0]?.instructions,
      criteria: { true: "Yes.", false: "No." },
    });
  });

  it("names each choice in its criterion and lists score levels in order", () => {
    const body = toOpenRouterRequest(eggRequest, MODEL);
    const payoff = body.questions.payoff;
    assert.equal(payoff?.type, "choice");
    assert.deepEqual(
      Object.keys(payoff.criteria),
      [...eggSegments.map((segment) => segmentName(segment.index)), "none"],
    );
    assert.equal(payoff.criteria.none, "none: the promise is never delivered");
    assert.match(payoff.criteria.S1 ?? "", /^S1: 0:00-/);
    const score = body.questions[scoreName(0)];
    assert.equal(score?.type, "score");
    assert.deepEqual(score.criteria.map((criterion) => criterion.split(":")[0]), ["filler", "context", "substance"]);
  });

  it("turns the refinement into one choice over the lines", () => {
    const body = toOpenRouterRequest(eggRefinement, MODEL);
    assert.deepEqual(Object.keys(body.questions), ["start"]);
    assert.deepEqual(Object.keys(body.questions.start?.criteria ?? {}), ["L1", "L2", "L3"]);
  });
});

describe("OpenRouter client", () => {
  it("posts to OpenRouter's Decisions API with the key and the chosen model", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse(openRouterReply()));
    await createOpenRouterClient(API_KEY, MODEL, fetch).decide(eggRequest, eggSegments);
    const [call] = calls;
    assert.equal(call?.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(new Headers(call?.init.headers).get("authorization"), "Bearer sk-test-not-a-real-key");
    assert.deepEqual(JSON.parse(String(call?.init.body)), toOpenRouterRequest(eggRequest, MODEL));
  });

  it("answers in the shape mapResponse reads", async () => {
    const { fetch } = stubFetch(() => jsonResponse(openRouterReply()));
    const response = await createOpenRouterClient(API_KEY, MODEL, fetch).decide(eggRequest, eggSegments);
    const { analysis, refusals, inputTokens, cachedTokens } = mapResponse(response, egg, eggSegments);
    assert.equal(analysis.model, "openai/gpt-6-luna-decisions-20261006");
    assert.equal(analysis.delivers, 0.91);
    assert.deepEqual(analysis.payoff, { startMs: eggSegments[1]?.startMs, segmentIndex: 1, confidence: 0.8 });
    assert.equal(analysis.segments[1]?.level, "substance");
    assert.equal(analysis.segments[1]?.payoffProbability, 0.84);
    assert.equal(analysis.segments[0]?.level, "filler");
    assert.deepEqual(refusals, []);
    assert.equal(inputTokens, 476);
    assert.equal(cachedTokens, 0);
  });

  it("reports its own model in the progress events", async () => {
    const { fetch } = stubFetch(() => jsonResponse(openRouterReply()));
    const events: unknown[] = [];
    await runAnalysis(createOpenRouterClient(API_KEY, MODEL, fetch), egg, (event) => events.push(event), () => {});
    const starts = events.filter((event) => isRecord(event) && event.type === "call-start");
    assert.ok(starts.length > 0);
    for (const start of starts) assert.equal((start as { model: string }).model, MODEL);
  });

  it("reads the refinement's chosen line", async () => {
    const reply = {
      model: MODEL,
      answers: { start: { type: "choice", choice: "L2" } },
      usage: { input_tokens: 9, output_tokens: 1 },
    };
    const { fetch } = stubFetch(() => jsonResponse(reply));
    const response = await createOpenRouterClient(API_KEY, MODEL, fetch).refine(eggRefinement, eggRefinementLines);
    assert.equal(mapRefinement(response, eggRefinementLines).startMs, eggRefinementLines[1]?.startMs);
  });

  it("treats a missing answer as a refusal and a wrong type as an invalid response", () => {
    const missing = openRouterReply();
    delete (missing.answers as Record<string, unknown>).delivers;
    assert.deepEqual(mapResponse(fromOpenRouterResponse(missing, eggRequest), egg, eggSegments).refusals, ["delivers"]);

    const wrong = openRouterReply();
    (wrong.answers as Record<string, unknown>).delivers = { type: "choice", choice: "S1" };
    assert.throws(
      () => mapResponse(fromOpenRouterResponse(wrong, eggRequest), egg, eggSegments),
      (error: unknown) => error instanceof ModelError && error.reason === "invalid response",
    );
  });

  it("fills in a choice's confidence and a score's probabilities when the model leaves them out", () => {
    const reply = openRouterReply();
    const answers = reply.answers as Record<string, Record<string, unknown>>;
    delete answers.payoff?.confidence;
    answers[scoreName(0)] = { type: "score", score: 1.6 };
    const { analysis } = mapResponse(fromOpenRouterResponse(reply, eggRequest), egg, eggSegments);
    assert.equal(analysis.payoff?.confidence, 0.84);
    assert.equal(analysis.segments[0]?.level, "substance");
    assert.equal(analysis.segments[0]?.substance, 0.8);
  });

  it("rejects a reply without answers or usage, and reports HTTP failures by status", async () => {
    assert.throws(() => fromOpenRouterResponse({ model: MODEL }, eggRequest), ModelError);
    const { fetch } = stubFetch(() => jsonResponse({ error: { code: 402, message: "Insufficient credits" } }, 402));
    await assert.rejects(
      createOpenRouterClient(API_KEY, MODEL, fetch).decide(eggRequest, eggSegments),
      (error: unknown) => error instanceof ModelError && error.reason === "HTTP 402",
    );
  });
});
