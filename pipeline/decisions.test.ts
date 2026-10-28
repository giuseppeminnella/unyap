import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalyzeRequest } from "../shared/types.ts";
import {
  buildDecisionsRequest,
  buildRefinementRequest,
  createLiveClient,
  createMockClient,
  type DecisionsResponse,
  ModelError,
} from "./decisions.ts";
import { segmentTranscript } from "./segments.ts";
import {
  API_KEY,
  egg,
  eggDecisionsRequest,
  eggRefinementLines,
  eggRefinementRequest,
  jsonResponse,
  stubFetch,
} from "./test-fixtures.ts";

const eggSegments = segmentTranscript(egg);
const eggRequest = buildDecisionsRequest(egg, eggSegments);
const eggRefinement = buildRefinementRequest(egg, eggRefinementLines);

async function failureOf(
  respond: () => Response | Promise<Response>,
  call: "decide" | "refine" = "decide",
): Promise<ModelError> {
  const { fetch } = stubFetch(respond);
  const client = createLiveClient(API_KEY, fetch);
  const pending = call === "decide"
    ? client.decide(eggRequest, eggSegments)
    : client.refine(eggRefinement, eggRefinementLines);
  const error: unknown = await pending.then(
    () => assert.fail("expected a model failure"),
    (rejection: unknown) => rejection,
  );
  assert.ok(error instanceof ModelError);
  return error;
}

describe("buildDecisionsRequest", () => {
  it("builds the exact request for egg.json", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(eggRequest)), eggDecisionsRequest);
  });

  it("keeps only the first 1000 characters of the description and drops an empty one", () => {
    const long = buildDecisionsRequest({ ...egg, description: "x".repeat(1500) }, eggSegments);
    assert.match(long.input[0]?.content ?? "", /^Title: How to boil an egg\nDescription: x{1000}\nTranscript:\n/);
    const { description: _, ...withoutDescription } = egg;
    for (const request of [withoutDescription, { ...egg, description: "" }]) {
      const content = buildDecisionsRequest(request, eggSegments).input[0]?.content ?? "";
      assert.match(content, /^Title: How to boil an egg\nTranscript:\n\[S1 0:00-0:30\] /);
    }
  });
});

describe("buildRefinementRequest", () => {
  it("builds the exact request for egg with S2 chosen", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(eggRefinement)), eggRefinementRequest);
  });

  it("writes times from an hour on as h:mm:ss", () => {
    const lines = [
      { startMs: 3_599_000, durationMs: 1000, text: "Almost there." },
      { startMs: 3_601_000, durationMs: 1000, text: "  Here\tit is.\n" },
    ];
    const request = buildRefinementRequest(egg, lines);
    assert.equal(
      request.input[0]?.content,
      "Title: How to boil an egg\n\nTranscript excerpt:\n[L1 59:59] Almost there.\n[L2 1:00:01] Here it is.",
    );
    const [question] = request.questions;
    assert.ok(question?.type === "choice");
    assert.deepEqual(question.choices, [
      { value: "L1", description: "59:59" },
      { value: "L2", description: "1:00:01" },
    ]);
  });
});

describe("live client", () => {
  it("posts to the Decisions API with the key and a timeout signal", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    assert.deepEqual(await createLiveClient(API_KEY, fetch).decide(eggRequest, eggSegments), { ok: true });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call?.url, "https://api.openai.com/v1/decisions");
    assert.equal(call?.init.method, "POST");
    const headers = new Headers(call?.init.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-test-not-a-real-key");
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(call?.init.body)), eggDecisionsRequest);
    assert.ok(call?.init.signal instanceof AbortSignal);
  });

  it("reports the status and error code, never the upstream message", async () => {
    const error = await failureOf(() =>
      jsonResponse(
        {
          error: {
            message: "You exceeded your current quota. Key sk-test-not-a-real-key",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        },
        429,
      )
    );
    assert.equal(error.reason, "HTTP 429 insufficient_quota");
    assert.equal(error.message, "Model call failed: HTTP 429 insufficient_quota");
  });

  it("reports only the status when the error body has no code", async () => {
    assert.equal((await failureOf(() => new Response("Bad gateway", { status: 502 }))).reason, "HTTP 502");
    assert.equal((await failureOf(() => jsonResponse({ error: { code: null } }, 500))).reason, "HTTP 500");
  });

  it("reports network errors and timeouts", async () => {
    assert.equal((await failureOf(() => Promise.reject(new TypeError("fetch failed")))).reason, "network error");
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    assert.equal((await failureOf(() => Promise.reject(timeout))).reason, "timeout");
  });

  it("reports a body that is not JSON as an invalid response", async () => {
    assert.equal((await failureOf(() => new Response("<html>"))).reason, "invalid response");
  });

  it("posts the refinement request the same way", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    assert.deepEqual(await createLiveClient(API_KEY, fetch).refine(eggRefinement, eggRefinementLines), { ok: true });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call?.url, "https://api.openai.com/v1/decisions");
    assert.equal(call?.init.method, "POST");
    const headers = new Headers(call?.init.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-test-not-a-real-key");
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(call?.init.body)), eggRefinementRequest);
    assert.ok(call?.init.signal instanceof AbortSignal);
  });

  it("reports refinement failures with the same reasons", async () => {
    const http = await failureOf(() => jsonResponse({ error: { code: "server_error" } }, 500), "refine");
    assert.equal(http.reason, "HTTP 500 server_error");
    const network = await failureOf(() => Promise.reject(new TypeError("fetch failed")), "refine");
    assert.equal(network.reason, "network error");
    assert.equal((await failureOf(() => new Response("<html>"), "refine")).reason, "invalid response");
  });
});

describe("mock client", () => {
  it("answers egg.json deterministically", async () => {
    const response = await createMockClient().decide(eggRequest, eggSegments);
    const filler = {
      type: "score",
      score: 0.25,
      confidence: 0.75,
      probabilities: [
        { label: "filler", value: 0, probability: 0.75 },
        { label: "context", value: 1, probability: 0.25 },
        { label: "substance", value: 2, probability: 0 },
      ],
    };
    const substance = {
      type: "score",
      score: 1.75,
      confidence: 0.75,
      probabilities: [
        { label: "filler", value: 0, probability: 0 },
        { label: "context", value: 1, probability: 0.25 },
        { label: "substance", value: 2, probability: 0.75 },
      ],
    };
    const expected: DecisionsResponse = {
      model: "mock",
      answers: [
        { type: "predicate", name: "delivers", probability: 0.9 },
        {
          type: "choice",
          name: "payoff",
          choice: "S2",
          confidence: 0.8,
          probabilities: [{ value: "S2", probability: 0.8 }, { value: "none", probability: 0.2 }],
        },
        { ...filler, type: "score", name: "substance_S1" },
        { ...substance, type: "score", name: "substance_S2" },
        { ...substance, type: "score", name: "substance_S3" },
        { ...filler, type: "score", name: "substance_S4" },
      ],
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    };
    assert.deepEqual(response, expected);
  });

  it("calls non-filler segments before the payoff context", async () => {
    const request: AnalyzeRequest = {
      videoId: "abcdefghijk",
      title: "Test",
      lengthSeconds: 120,
      transcript: [
        { startMs: 0, durationMs: 1000, text: "Eggs come from hens." },
        { startMs: 30_000, durationMs: 1000, text: "Boil them." },
        { startMs: 60_000, durationMs: 1000, text: "This video is sponsored by a sponsor." },
        { startMs: 90_000, durationMs: 1000, text: "Peel them." },
      ],
    };
    const segments = segmentTranscript(request);
    const response = (await createMockClient().decide(buildDecisionsRequest(request, segments), segments)) as
      DecisionsResponse;
    const scores = response.answers.flatMap((answer) => answer.type === "score" ? [answer.score] : []);
    assert.deepEqual(scores, [0.75, 1.75, 0.25, 1.75]);
  });

  it("answers none when every segment after the first quarter is filler", async () => {
    const request: AnalyzeRequest = {
      videoId: "abcdefghijk",
      title: "Test",
      lengthSeconds: 60,
      transcript: [
        { startMs: 0, durationMs: 1000, text: "Boil them." },
        { startMs: 30_000, durationMs: 1000, text: "In this video we will see." },
      ],
    };
    const segments = segmentTranscript(request);
    const response = (await createMockClient().decide(buildDecisionsRequest(request, segments), segments)) as
      DecisionsResponse;
    assert.deepEqual(response.answers.slice(0, 2), [
      { type: "predicate", name: "delivers", probability: 0.2 },
      {
        type: "choice",
        name: "payoff",
        choice: "none",
        confidence: 0.8,
        probabilities: [{ value: "none", probability: 0.8 }],
      },
    ]);
    const scores = response.answers.flatMap((answer) => answer.type === "score" ? [answer.score] : []);
    assert.deepEqual(scores, [0.75, 0.25]);
  });

  it("starts egg's payoff at the first line that is not filler", async () => {
    const response = await createMockClient().refine(eggRefinement, eggRefinementLines);
    const expected: DecisionsResponse = {
      model: "mock",
      answers: [
        {
          type: "choice",
          name: "start",
          choice: "L3",
          confidence: 0.8,
          probabilities: [{ value: "L3", probability: 0.8 }],
        },
      ],
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    };
    assert.deepEqual(response, expected);
  });

  it("starts at L1 when every line is filler", async () => {
    const lines = eggRefinementLines.slice(0, 2);
    const response = (await createMockClient().refine(buildRefinementRequest(egg, lines), lines)) as DecisionsResponse;
    assert.deepEqual(response.answers, [
      {
        type: "choice",
        name: "start",
        choice: "L1",
        confidence: 0.8,
        probabilities: [{ value: "L1", probability: 0.8 }],
      },
    ]);
  });
});
