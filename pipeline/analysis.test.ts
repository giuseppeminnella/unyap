import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Analysis, AnalyzeRequest } from "../shared/types.ts";
import { type CallLog, mapRefinement, mapResponse, runAnalysis } from "./analysis.ts";
import { createLiveClient, createMockClient, type DecisionsClient, ModelError } from "./decisions.ts";
import { segmentTranscript } from "./segments.ts";
import {
  API_KEY,
  egg,
  eggDecisionsRequest,
  eggRefinementLines,
  eggRefinementRequest,
  jsonResponse,
  recordedResponse,
  refinementResponse,
  type ResponseBody,
  stubFetch,
} from "./test-fixtures.ts";
import { callLogs, captureConsole } from "./test-helpers.ts";

const eggSegments = segmentTranscript(egg);

/** The mock refinement log line for egg, without latencyMs. */
const mockRefineLog = {
  event: "decisions_call",
  call: "refine",
  mode: "mock",
  videoId: "abcdefghijk",
  segments: 4,
  lines: 3,
  inputTokens: 0,
  cachedTokens: 0,
  refusals: [],
  ok: true,
};

/** The log line with latencyMs set to 0, so tests can compare it as a string. */
function zeroLatency(line: string | undefined): string | undefined {
  return line?.replace(/"latencyMs":\d+,/, '"latencyMs":0,');
}

function withoutCreatedAt({ createdAt: _, ...rest }: Analysis): Omit<Analysis, "createdAt"> {
  return rest;
}

/** Answers the main call with `main` and the refinement call with `refine`. */
function liveClient(
  main: () => Response | Promise<Response>,
  refine: () => Response | Promise<Response> = () => assert.fail("unexpected refinement call"),
) {
  const { fetch, calls } = stubFetch((call) => call === 0 ? main() : refine());
  return { client: createLiveClient(API_KEY, fetch), calls };
}

describe("runAnalysis", () => {
  it("sends the exact live requests and refines the payoff to the chosen line", async (t) => {
    const lines = captureConsole(t);
    const { client, calls } = liveClient(
      () => jsonResponse(recordedResponse()),
      () => jsonResponse(refinementResponse("L3")),
    );
    const analysis = await runAnalysis(client, egg);

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, "https://api.openai.com/v1/decisions");
      assert.equal(call.init.method, "POST");
      const headers = new Headers(call.init.headers);
      assert.equal(headers.get("authorization"), "Bearer sk-test-not-a-real-key");
      assert.equal(headers.get("content-type"), "application/json");
    }
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), eggDecisionsRequest);
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), eggRefinementRequest);

    assert.ok(!Number.isNaN(Date.parse(analysis.createdAt)));
    assert.deepEqual(withoutCreatedAt(analysis), {
      videoId: "abcdefghijk",
      title: "How to boil an egg",
      lengthSeconds: 100,
      segments: [
        { index: 0, startMs: 0, endMs: 30_000, substance: 0.05, level: "filler", payoffProbability: 0 },
        { index: 1, startMs: 30_000, endMs: 60_000, substance: 0.5, level: "context", payoffProbability: 0.81 },
        { index: 2, startMs: 60_000, endMs: 90_000, substance: 0.9, level: "substance", payoffProbability: 0.12 },
        { index: 3, startMs: 90_000, endMs: 100_000, substance: 0.015, level: "filler", payoffProbability: 0 },
      ],
      payoff: { startMs: 31_000, segmentIndex: 1, confidence: 0.81 },
      delivers: 0.93,
      substanceRatio: 0.6,
      model: "gpt-6-luna",
      cached: false,
    });

    assert.equal(lines().length, 2);
    const [main, refine] = lines();
    assert.match(main ?? "", /"latencyMs":\d+,/);
    assert.match(refine ?? "", /"latencyMs":\d+,/);
    assert.equal(
      zeroLatency(main),
      '{"event":"decisions_call","mode":"live","videoId":"abcdefghijk","segments":4,"latencyMs":0,' +
        '"inputTokens":412,"cachedTokens":256,"refusals":["substance_S2"],"ok":true}',
    );
    assert.equal(
      zeroLatency(refine),
      '{"event":"decisions_call","call":"refine","mode":"live","videoId":"abcdefghijk","segments":4,"lines":3,' +
        '"latencyMs":0,"inputTokens":95,"cachedTokens":0,"refusals":[],"ok":true}',
    );
  });

  it("maps the mock answers for egg.json", async (t) => {
    const lines = captureConsole(t);
    const analysis = await runAnalysis(createMockClient(), egg);
    assert.deepEqual(
      analysis.segments.map(({ substance, level, payoffProbability }) => [substance, level, payoffProbability]),
      [[0.125, "filler", 0], [0.875, "substance", 0.8], [0.875, "substance", 0], [0.125, "filler", 0]],
    );
    assert.deepEqual(analysis.payoff, { startMs: 31_000, segmentIndex: 1, confidence: 0.8 });
    assert.equal(analysis.delivers, 0.9);
    assert.equal(analysis.substanceRatio, 0.6);
    assert.equal(analysis.model, "mock");
    assert.deepEqual(callLogs(lines()).map(({ latencyMs: _, ...rest }) => rest), [
      {
        event: "decisions_call",
        mode: "mock",
        videoId: "abcdefghijk",
        segments: 4,
        inputTokens: 0,
        cachedTokens: 0,
        refusals: [],
        ok: true,
      },
      mockRefineLog,
    ]);
  });

  it("hands the call log to a custom logger instead of the console", async (t) => {
    const lines = captureConsole(t);
    const logged: CallLog[] = [];
    await runAnalysis(createMockClient(), egg, () => {}, (line) => logged.push(line));
    assert.deepEqual(lines(), []);
    assert.deepEqual(logged.map(({ call }) => call), [undefined, "refine"]);
  });

  it("rejects with the ModelError of a failed main call and logs it", async (t) => {
    const lines = captureConsole(t);
    const client: DecisionsClient = {
      mode: "mock",
      decide: () => Promise.reject(new ModelError("network error")),
      refine: () => assert.fail("no refinement after a failed main call"),
    };
    await assert.rejects(
      runAnalysis(client, egg),
      (error) => error instanceof ModelError && error.reason === "network error",
    );
    const [failure] = callLogs(lines());
    assert.deepEqual({ ...failure, latencyMs: 0 }, {
      event: "decisions_call",
      mode: "mock",
      videoId: "abcdefghijk",
      segments: 4,
      latencyMs: 0,
      inputTokens: null,
      cachedTokens: null,
      refusals: [],
      ok: false,
      error: "network error",
    });
    assert.equal(callLogs(lines()).length, 1);
  });

  it("logs an invalid response as a failure", async (t) => {
    const lines = captureConsole(t);
    const client: DecisionsClient = {
      mode: "live",
      decide: async () => ({ model: "gpt-6-luna", answers: [] }),
      refine: () => assert.fail("no refinement after a failed main call"),
    };
    await assert.rejects(runAnalysis(client, egg), {
      message: "Model call failed: invalid response",
    });
    const logs = callLogs(lines()).map(({ ok, error }) => ({ ok, error }));
    assert.deepEqual(logs, [{ ok: false, error: "invalid response" }]);
  });

  const refusedStart = refinementResponse("L3");
  refusedStart.answers = [{ type: "refusal", name: "start" }];
  const failedRefinement = { inputTokens: null, cachedTokens: null, refusals: [], ok: false };
  const refinementFailures: [string, () => Response | Promise<Response>, Record<string, unknown>][] = [
    ["an HTTP 500", () => jsonResponse({ error: { code: "server_error" } }, 500), {
      ...failedRefinement,
      error: "HTTP 500 server_error",
    }],
    ["a network error", () => Promise.reject(new TypeError("fetch failed")), {
      ...failedRefinement,
      error: "network error",
    }],
    ["a refused start", () => jsonResponse(refusedStart), {
      inputTokens: 95,
      cachedTokens: 0,
      refusals: ["start"],
      ok: true,
    }],
    ["a choice that is no line", () => jsonResponse(refinementResponse("L4")), {
      ...failedRefinement,
      error: "invalid response",
    }],
  ];
  for (const [name, refine, logged] of refinementFailures) {
    it(`keeps the segment start and resolves when the refinement gets ${name}`, async (t) => {
      const lines = captureConsole(t);
      const { client, calls } = liveClient(() => jsonResponse(recordedResponse()), refine);
      const analysis = await runAnalysis(client, egg);
      assert.equal(calls.length, 2);
      assert.deepEqual(analysis.payoff, { startMs: 30_000, segmentIndex: 1, confidence: 0.81 });
      assert.equal(analysis.cached, false);
      const logs = callLogs(lines());
      assert.equal(logs.length, 2);
      assert.equal(logs[0]?.call, undefined);
      assert.equal(logs[0]?.ok, true);
      assert.deepEqual({ ...logs[1], latencyMs: 0 }, {
        event: "decisions_call",
        call: "refine",
        mode: "live",
        videoId: "abcdefghijk",
        segments: 4,
        lines: 3,
        latencyMs: 0,
        ...logged,
      });
    });
  }

  it("lets a refinement error that is no ModelError propagate", async (t) => {
    const lines = captureConsole(t);
    const mock = createMockClient();
    const client: DecisionsClient = {
      mode: "mock",
      decide: (request, segments) => mock.decide(request, segments),
      refine: () => Promise.reject(new TypeError("bug")),
    };
    await assert.rejects(runAnalysis(client, egg), TypeError);
    assert.deepEqual(callLogs(lines()).map(({ ok, error }) => ({ ok, error })), [
      { ok: true, error: undefined },
      { ok: false, error: "internal error" },
    ]);
  });

  const skipped: [string, AnalyzeRequest, (response: ResponseBody) => void, number | null][] = [
    ["payoff none", egg, (response) => {
      response.answers[1] = { ...response.answers[1], choice: "none" };
    }, null],
    ["a refused payoff", egg, (response) => {
      response.answers[1] = { type: "refusal", name: "payoff" };
    }, null],
    // S2 is still chosen, but only one line starts in [0 s, 60 s).
    ["a window with one line", { ...egg, transcript: egg.transcript.slice(2) }, () => {}, 30_000],
  ];
  for (const [name, request, edit, startMs] of skipped) {
    it(`makes one model call and writes one log line for ${name}`, async (t) => {
      const lines = captureConsole(t);
      const response = recordedResponse();
      edit(response);
      const { client, calls } = liveClient(() => jsonResponse(response));
      const analysis = await runAnalysis(client, request);
      assert.equal(calls.length, 1);
      assert.equal(callLogs(lines()).length, 1);
      assert.equal(callLogs(lines())[0]?.call, undefined);
      assert.equal(analysis.payoff?.startMs ?? null, startMs);
    });
  }
});

describe("mapResponse", () => {
  function map(edit: (response: ReturnType<typeof recordedResponse>) => void) {
    const response = recordedResponse();
    edit(response);
    return mapResponse(response, egg, eggSegments);
  }

  it("maps a refused score to substance 0.5, level context", () => {
    const { analysis, refusals } = map(() => {});
    assert.deepEqual(analysis.segments[1], {
      index: 1,
      startMs: 30_000,
      endMs: 60_000,
      substance: 0.5,
      level: "context",
      payoffProbability: 0.81,
    });
    assert.deepEqual(refusals, ["substance_S2"]);
  });

  it("maps a refused payoff to no payoff and zero payoff probabilities", () => {
    const { analysis, refusals } = map((response) => {
      response.answers[1] = { type: "refusal", name: "payoff" };
    });
    assert.equal(analysis.payoff, null);
    assert.deepEqual(analysis.segments.map((segment) => segment.payoffProbability), [0, 0, 0, 0]);
    assert.deepEqual(refusals, ["payoff", "substance_S2"]);
  });

  it("maps a refused delivers to 0.5", () => {
    const { analysis, refusals } = map((response) => {
      response.answers[0] = { type: "refusal", name: "delivers" };
    });
    assert.equal(analysis.delivers, 0.5);
    assert.deepEqual(refusals, ["delivers", "substance_S2"]);
  });

  it("maps choice none to no payoff but keeps the payoff probabilities", () => {
    const { analysis } = map((response) => {
      response.answers[1] = { ...response.answers[1], choice: "none" };
    });
    assert.equal(analysis.payoff, null);
    assert.deepEqual(analysis.segments.map((segment) => segment.payoffProbability), [0, 0.81, 0.12, 0]);
  });

  it("picks the first level on a tie", () => {
    const { analysis } = map((response) => {
      response.answers[2] = {
        ...response.answers[2],
        probabilities: [
          { label: "filler", value: 0, probability: 0.5 },
          { label: "context", value: 1, probability: 0.5 },
          { label: "substance", value: 2, probability: 0 },
        ],
      };
    });
    assert.equal(analysis.segments[0]?.level, "filler");
  });

  const broken: [string, (response: ReturnType<typeof recordedResponse>) => void][] = [
    ["a missing score", (response) => void response.answers.splice(4, 1)],
    ["a missing delivers", (response) => void response.answers.splice(0, 1)],
    ["an answer of the wrong type", (response) => (response.answers[0] = { type: "score", name: "delivers" })],
    ["a probability that is not a number", (response) => {
      response.answers[0] = { ...response.answers[0], probability: "0.9" };
    }],
    ["a payoff choice that is no segment", (response) => {
      response.answers[1] = { ...response.answers[1], choice: "S9" };
    }],
    ["an unknown level", (response) => {
      response.answers[2] = { ...response.answers[2], probabilities: [{ label: "great", value: 0, probability: 1 }] };
    }],
    ["no usage", (response) => (response.usage = undefined)],
    ["no answers", (response) => (response.answers = undefined as unknown as Record<string, unknown>[])],
  ];
  for (const [name, edit] of broken) {
    it(`rejects ${name} as an invalid response`, () => {
      assert.throws(() => map(edit), (error) => error instanceof ModelError && error.reason === "invalid response");
    });
  }

  it("rejects a body that is not an object", () => {
    assert.throws(() => mapResponse(null, egg, eggSegments), ModelError);
  });
});

describe("mapRefinement", () => {
  function map(edit: (response: ResponseBody) => void) {
    const response = refinementResponse("L2");
    edit(response);
    return mapRefinement(response, eggRefinementLines);
  }

  it("maps the chosen line to its name and startMs", () => {
    assert.deepEqual(map(() => {}), { startMs: 4_000, line: "L2", refusals: [], inputTokens: 95, cachedTokens: 0 });
  });

  it("maps a refused start to no startMs and no line", () => {
    const mapped = map((response) => (response.answers[0] = { type: "refusal", name: "start" }));
    assert.deepEqual(mapped, { startMs: null, line: null, refusals: ["start"], inputTokens: 95, cachedTokens: 0 });
  });

  const broken: [string, (response: ResponseBody) => void][] = [
    ["a choice that is no line", (response) => (response.answers[0] = { ...response.answers[0], choice: "L4" })],
    ["a segment choice", (response) => (response.answers[0] = { ...response.answers[0], choice: "S2" })],
    ["a missing start", (response) => (response.answers = [])],
    ["an answer of the wrong type", (response) => (response.answers[0] = { type: "predicate", name: "start" })],
    ["no usage", (response) => (response.usage = undefined)],
  ];
  for (const [name, edit] of broken) {
    it(`rejects ${name} as an invalid response`, () => {
      assert.throws(() => map(edit), (error) => error instanceof ModelError && error.reason === "invalid response");
    });
  }
});
