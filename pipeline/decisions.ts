// The Decisions requests (prompts, questions, ANALYSIS_VERSION) and the clients that answer them.
// See docs/decisions-api.md. Change the wording here only together with an ANALYSIS_VERSION bump.
import { formatTime } from "../shared/timeline.ts";
import type { AnalyzeRequest, SubstanceLevel, TranscriptLine } from "../shared/types.ts";
import { collapseWhitespace, NO_SPEECH, type SegmentText } from "./segments.ts";
import { isRecord } from "./guards.ts";

/** Stored with each locally cached analysis: bump it whenever the prompt or the questions change. */
export const ANALYSIS_VERSION = 2;

export const DECISIONS_URL = "https://api.openai.com/v1/decisions";
const MODEL = "gpt-6-luna";
const TIMEOUT_MS = 60_000;

const DELIVERS_INSTRUCTIONS =
  "Does the video, anywhere, actually deliver the specific thing its title promises " +
  "(an answer, a reveal, a result, a list, a how-to)?";
const PAYOFF_INSTRUCTIONS =
  "Which segment is where the video actually answers its title: where it states the answer, verdict, result or reveal that the title promises? If the answer builds up over several segments, choose the one where it is first clearly stated. Choose none if the promise is never delivered.";
const START_INSTRUCTIONS =
  "At which line does the speaker start stating the answer, verdict, result or reveal that the title promises? Pick the first line of that statement, so a viewer who starts there hears all of it.";

export interface DecisionsLevel {
  label: SubstanceLevel;
  description: string;
}

const LEVELS: DecisionsLevel[] = [
  {
    label: "filler",
    description:
      "intros, greetings, channel or sponsor plugs, like/subscribe requests, teasers of what is coming, " +
      "repetition, off-topic tangents",
  },
  { label: "context", description: "background or setup that leads toward the promise without delivering it" },
  { label: "substance", description: "directly delivers information, answers or results the title promises" },
];

export type DecisionsQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description: string }[] }
  | { type: "score"; name: string; instructions: string; levels: DecisionsLevel[] };

export interface DecisionsRequest {
  model: string;
  input: { role: "user"; content: string }[];
  questions: DecisionsQuestion[];
  prompt_cache_key: string;
}

export type DecisionsAnswer =
  | { type: "predicate"; name: string; probability: number }
  | {
    type: "choice";
    name: string;
    choice: string;
    confidence: number;
    probabilities: { value: string; probability: number }[];
  }
  | {
    type: "score";
    name: string;
    score: number;
    confidence: number;
    probabilities: { label: string; value: number; probability: number }[];
  }
  | { type: "refusal"; name: string };

export interface DecisionsResponse {
  model: string;
  answers: DecisionsAnswer[];
  usage: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
  };
}

/** The model call failed; `reason` is safe to return and log (never the upstream message). */
export class ModelError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Model call failed: ${reason}`);
    this.reason = reason;
  }
}

/** "mock" answers deterministically without calling OpenAI (tests, e2e). */
export type DecisionsMode = "live" | "mock";

export interface DecisionsClient {
  readonly mode: DecisionsMode;
  /** Resolves with the response body as docs/decisions-api.md shows it (unchecked), or rejects with a ModelError. */
  decide(request: DecisionsRequest, segments: readonly SegmentText[]): Promise<unknown>;
  /** The same for the refinement request built from `lines`. */
  refine(request: DecisionsRequest, lines: readonly TranscriptLine[]): Promise<unknown>;
}

/** "S1" for the first segment. */
export function segmentName(index: number): string {
  return `S${index + 1}`;
}

export function scoreName(index: number): string {
  return `substance_${segmentName(index)}`;
}

/** "L1" for the first refinement line. */
export function lineName(index: number): string {
  return `L${index + 1}`;
}

function timeRange(segment: SegmentText): string {
  return `${formatTime(segment.startMs)}-${formatTime(segment.endMs)}`;
}

function promptText(request: AnalyzeRequest, segments: readonly SegmentText[]): string {
  const lines = [`Title: ${request.title}`];
  if (request.description) lines.push(`Description: ${request.description.slice(0, 1000)}`);
  lines.push("Transcript:");
  for (const segment of segments) lines.push(`[${segmentName(segment.index)} ${timeRange(segment)}] ${segment.text}`);
  return lines.join("\n");
}

export function buildDecisionsRequest(request: AnalyzeRequest, segments: readonly SegmentText[]): DecisionsRequest {
  return {
    model: MODEL,
    input: [{ role: "user", content: promptText(request, segments) }],
    questions: [
      { type: "predicate", name: "delivers", instructions: DELIVERS_INSTRUCTIONS },
      {
        type: "choice",
        name: "payoff",
        instructions: PAYOFF_INSTRUCTIONS,
        choices: [
          ...segments.map((segment) => ({ value: segmentName(segment.index), description: timeRange(segment) })),
          { value: "none", description: "the promise is never delivered" },
        ],
      },
      ...segments.map((segment): DecisionsQuestion => ({
        type: "score",
        name: scoreName(segment.index),
        instructions:
          `Judge only segment ${segmentName(segment.index)} (${timeRange(segment)}). ` +
          "How much of it delivers what the title promises?",
        levels: LEVELS,
      })),
    ],
    prompt_cache_key: request.videoId,
  };
}

/** The second call: which of the lines around the chosen segment starts the payoff. */
export function buildRefinementRequest(request: AnalyzeRequest, lines: readonly TranscriptLine[]): DecisionsRequest {
  const excerpt = lines.map((line, i) =>
    `[${lineName(i)} ${formatTime(line.startMs)}] ${collapseWhitespace(line.text)}`
  );
  const content = `Title: ${request.title}\n\nTranscript excerpt:\n${excerpt.join("\n")}`;
  return {
    model: MODEL,
    input: [{ role: "user", content }],
    questions: [
      {
        type: "choice",
        name: "start",
        instructions: START_INSTRUCTIONS,
        choices: lines.map((line, i) => ({ value: lineName(i), description: formatTime(line.startMs) })),
      },
    ],
    prompt_cache_key: request.videoId,
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

async function httpFailure(res: Response): Promise<string> {
  // Keep only the status and error.code: OpenAI error messages can echo part of the API key.
  const body: unknown = await res.json().catch(() => undefined);
  const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
  return typeof code === "string" && code !== "" ? `HTTP ${res.status} ${code}` : `HTTP ${res.status}`;
}

export function createLiveClient(apiKey: string, fetchFn: typeof fetch = fetch): DecisionsClient {
  async function post(request: DecisionsRequest): Promise<unknown> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      throw new ModelError(isTimeout(error) ? "timeout" : "network error");
    }
    if (!res.ok) throw new ModelError(await httpFailure(res));
    try {
      return (await res.json()) as unknown;
    } catch (error) {
      throw new ModelError(isTimeout(error) ? "timeout" : "invalid response");
    }
  }

  return { mode: "live", decide: post, refine: post };
}

const FILLER_TEXT = /subscribe|sponsor|welcome back|in this video/i;

const MOCK_SCORES: Record<SubstanceLevel, { score: number; probabilities: [number, number, number] }> = {
  filler: { score: 0.25, probabilities: [0.75, 0.25, 0] },
  context: { score: 0.75, probabilities: [0.25, 0.75, 0] },
  substance: { score: 1.75, probabilities: [0, 0.25, 0.75] },
};

const MOCK_USAGE: DecisionsResponse["usage"] = {
  input_tokens: 0,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 0,
};

/** Deterministic answers from the segment texts, without network. */
export function createMockClient(): DecisionsClient {
  return {
    mode: "mock",
    async decide(_request, segments): Promise<DecisionsResponse> {
      const lengthMs = segments.at(-1)?.endMs ?? 0;
      const filler = segments.map((segment) => segment.text === NO_SPEECH || FILLER_TEXT.test(segment.text));
      const payoff = segments.findIndex((segment, i) => !filler[i] && segment.startMs >= 0.25 * lengthMs);
      const levelOf = (i: number): SubstanceLevel =>
        filler[i] ? "filler" : payoff >= 0 && i >= payoff ? "substance" : "context";
      return {
        model: "mock",
        answers: [
          { type: "predicate", name: "delivers", probability: payoff >= 0 ? 0.9 : 0.2 },
          payoff >= 0
            ? {
              type: "choice",
              name: "payoff",
              choice: segmentName(payoff),
              confidence: 0.8,
              probabilities: [{ value: segmentName(payoff), probability: 0.8 }, { value: "none", probability: 0.2 }],
            }
            : {
              type: "choice",
              name: "payoff",
              choice: "none",
              confidence: 0.8,
              probabilities: [{ value: "none", probability: 0.8 }],
            },
          ...segments.map((segment, i): DecisionsAnswer => {
            const { score, probabilities } = MOCK_SCORES[levelOf(i)];
            const [fillerP, contextP, substanceP] = probabilities;
            return {
              type: "score",
              name: scoreName(segment.index),
              score,
              confidence: Math.max(...probabilities),
              probabilities: [
                { label: "filler", value: 0, probability: fillerP },
                { label: "context", value: 1, probability: contextP },
                { label: "substance", value: 2, probability: substanceP },
              ],
            };
          }),
        ],
        usage: MOCK_USAGE,
      };
    },
    async refine(_request, lines): Promise<DecisionsResponse> {
      const choice = lineName(Math.max(lines.findIndex((line) => !FILLER_TEXT.test(line.text)), 0));
      return {
        model: "mock",
        answers: [
          {
            type: "choice",
            name: "start",
            choice,
            confidence: 0.8,
            probabilities: [{ value: choice, probability: 0.8 }],
          },
        ],
        usage: MOCK_USAGE,
      };
    },
  };
}

