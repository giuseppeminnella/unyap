import type { AnalyzeRequest } from "../shared/types.ts";

export const API_KEY = "sk-test-not-a-real-key";

export const egg: AnalyzeRequest = {
  videoId: "abcdefghijk",
  title: "How to boil an egg",
  description: "The only egg guide you need.",
  lengthSeconds: 100,
  language: "en",
  transcript: [
    { startMs: 0, durationMs: 4000, text: "Welcome back to the channel!" },
    { startMs: 4000, durationMs: 3000, text: "Don't forget to\nsubscribe." },
    { startMs: 31000, durationMs: 5000, text: "First, bring the water to a boil." },
    { startMs: 62000, durationMs: 4000, text: "Cook for exactly seven minutes." },
  ],
};

const DELIVERS =
  "Does the video, anywhere, actually deliver the specific thing its title promises " +
  "(an answer, a reveal, a result, a list, a how-to)?";
const PAYOFF =
  "Which segment is where the video actually answers its title: where it states the answer, verdict, result or " +
  "reveal that the title promises? If the answer builds up over several segments, choose the one where it is first " +
  "clearly stated. Choose none if the promise is never delivered.";
const START =
  "At which line does the speaker start stating the answer, verdict, result or reveal that the title promises? " +
  "Pick the first line of that statement, so a viewer who starts there hears all of it.";
const LEVELS = [
  {
    label: "filler",
    description:
      "intros, greetings, channel or sponsor plugs, like/subscribe requests, teasers of what is coming, " +
      "repetition, off-topic tangents",
  },
  { label: "context", description: "background or setup that leads toward the promise without delivering it" },
  { label: "substance", description: "directly delivers information, answers or results the title promises" },
];

function score(name: string, range: string) {
  return {
    type: "score",
    name: `substance_${name}`,
    instructions: `Judge only segment ${name} (${range}). How much of it delivers what the title promises?`,
    levels: LEVELS,
  };
}

/** The exact main request for egg, as AGENTS.md "Analysis pipeline" describes it. */
export const eggDecisionsRequest = {
  model: "gpt-6-luna",
  input: [
    {
      role: "user",
      content:
        "Title: How to boil an egg\nDescription: The only egg guide you need.\nTranscript:\n" +
        "[S1 0:00-0:30] Welcome back to the channel! Don't forget to subscribe.\n" +
        "[S2 0:30-1:00] First, bring the water to a boil.\n" +
        "[S3 1:00-1:30] Cook for exactly seven minutes.\n" +
        "[S4 1:30-1:40] (no speech)",
    },
  ],
  questions: [
    { type: "predicate", name: "delivers", instructions: DELIVERS },
    {
      type: "choice",
      name: "payoff",
      instructions: PAYOFF,
      choices: [
        { value: "S1", description: "0:00-0:30" },
        { value: "S2", description: "0:30-1:00" },
        { value: "S3", description: "1:00-1:30" },
        { value: "S4", description: "1:30-1:40" },
        { value: "none", description: "the promise is never delivered" },
      ],
    },
    score("S1", "0:00-0:30"),
    score("S2", "0:30-1:00"),
    score("S3", "1:00-1:30"),
    score("S4", "1:30-1:40"),
  ],
  prompt_cache_key: "abcdefghijk",
};

/** The refinement lines for egg with S2 chosen: S1 and S2, i.e. [0, 60 000 ms). */
export const eggRefinementLines = egg.transcript.slice(0, 3);

/** The exact refinement request for egg with S2 chosen. */
export const eggRefinementRequest = {
  model: "gpt-6-luna",
  input: [
    {
      role: "user",
      content:
        "Title: How to boil an egg\n\nTranscript excerpt:\n" +
        "[L1 0:00] Welcome back to the channel!\n" +
        "[L2 0:04] Don't forget to subscribe.\n" +
        "[L3 0:31] First, bring the water to a boil.",
    },
  ],
  questions: [
    {
      type: "choice",
      name: "start",
      instructions: START,
      choices: [
        { value: "L1", description: "0:00" },
        { value: "L2", description: "0:04" },
        { value: "L3", description: "0:31" },
      ],
    },
  ],
  prompt_cache_key: "abcdefghijk",
};

/** A response body loose enough for tests to break it. */
export interface ResponseBody {
  model: string;
  answers: Record<string, unknown>[];
  usage: unknown;
}

/** A live-style main response for egg. A fresh copy each call, so tests can edit it. */
export function recordedResponse(): ResponseBody {
  return {
    model: "gpt-6-luna",
    answers: [
      { type: "predicate", name: "delivers", probability: 0.93 },
      {
        type: "choice",
        name: "payoff",
        choice: "S2",
        confidence: 0.81,
        probabilities: [
          { value: "S2", probability: 0.81 },
          { value: "S3", probability: 0.12 },
          { value: "none", probability: 0.04 },
        ],
      },
      {
        type: "score",
        name: "substance_S1",
        score: 0.1,
        confidence: 0.9,
        probabilities: [
          { label: "filler", value: 0, probability: 0.9 },
          { label: "context", value: 1, probability: 0.1 },
          { label: "substance", value: 2, probability: 0 },
        ],
      },
      { type: "refusal", name: "substance_S2" },
      {
        type: "score",
        name: "substance_S3",
        score: 1.8,
        confidence: 0.82,
        probabilities: [
          { label: "filler", value: 0, probability: 0.02 },
          { label: "context", value: 1, probability: 0.16 },
          { label: "substance", value: 2, probability: 0.82 },
        ],
      },
      {
        type: "score",
        name: "substance_S4",
        score: 0.03,
        confidence: 0.97,
        probabilities: [
          { label: "filler", value: 0, probability: 0.97 },
          { label: "context", value: 1, probability: 0.03 },
          { label: "substance", value: 2, probability: 0 },
        ],
      },
    ],
    usage: {
      input_tokens: 412,
      input_tokens_details: { cached_tokens: 256, cache_write_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 412,
    },
  };
}

/** A live-style refinement response choosing `choice`. A fresh copy each call, so tests can edit it. */
export function refinementResponse(choice: string): ResponseBody {
  return {
    model: "gpt-6-luna",
    answers: [
      {
        type: "choice",
        name: "start",
        choice,
        confidence: 0.74,
        probabilities: [{ value: choice, probability: 0.74 }, { value: "L2", probability: 0.2 }],
      },
    ],
    usage: {
      input_tokens: 95,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 95,
    },
  };
}

export interface FetchCall {
  url: string;
  init: RequestInit;
}

/** A fetch stand-in that records its calls and answers with `respond`, which gets the 0-based call number. */
export function stubFetch(
  respond: (call: number) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchStub = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(input), init });
    return respond(calls.length - 1);
  };
  return { fetch: fetchStub as typeof fetch, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
