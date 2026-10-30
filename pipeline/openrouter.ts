// The same Decisions requests sent to OpenRouter's Decisions API, which serves many decision models behind one key.
// See docs/openrouter-decisions.md. The client translates our request into OpenRouter's shape and its answers back
// into the response shape of docs/decisions-api.md, so mapResponse and mapRefinement read both providers alike.
import type { DecisionsQuestion } from "../shared/types.ts";
import { isFiniteNumber, isRecord } from "./guards.ts";
import {
  type DecisionsAnswer, type DecisionsClient, type DecisionsRequest, ModelError, postJson,
} from "./decisions.ts";

export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

type OpenRouterQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface OpenRouterRequest {
  model: string;
  state: string;
  questions: Record<string, OpenRouterQuestion>;
}

function toQuestion(question: DecisionsQuestion): OpenRouterQuestion {
  switch (question.type) {
    case "predicate":
      return { type: "noul", instructions: question.instructions, criteria: { true: "Yes.", false: "No." } };
    case "choice":
      // A criterion names its option, so the model can match it to the marker in the state.
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: Object.fromEntries(
          question.choices.map((choice) => [choice.value, `${choice.value}: ${choice.description}`]),
        ),
      };
    case "score":
      return {
        type: "score",
        instructions: question.instructions,
        criteria: question.levels.map((level) => `${level.label}: ${level.description}`),
      };
  }
}

/** Our request in OpenRouter's shape: the prompt becomes `state`, the questions an object keyed by name. */
export function toOpenRouterRequest(request: DecisionsRequest, model: string): OpenRouterRequest {
  return {
    model,
    state: request.input.map((message) => message.content).join("\n\n"),
    questions: Object.fromEntries(request.questions.map((question) => [question.name, toQuestion(question)])),
  };
}

/** The highest value in `probabilities`, or `fallback` when there is none. */
function top(probabilities: { probability: number }[], fallback: number): number {
  return probabilities.length > 0 ? Math.max(...probabilities.map((entry) => entry.probability)) : fallback;
}

function numberEntries(value: unknown): [string, number][] {
  if (!isRecord(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, number] => isFiniteNumber(entry[1]));
}

/**
 * One OpenRouter answer in our shape. An answer that is missing becomes a refusal; one of an unexpected shape keeps
 * its own type, so mapResponse rejects it as an invalid response.
 */
function fromAnswer(question: DecisionsQuestion, raw: unknown): DecisionsAnswer | { type: unknown; name: string } {
  const { name } = question;
  if (raw === undefined) return { type: "refusal", name };
  if (!isRecord(raw)) return { type: undefined, name };
  if (question.type === "predicate" && raw.type === "noul" && isFiniteNumber(raw.noul)) {
    return { type: "predicate", name, probability: raw.noul };
  }
  if (question.type === "choice" && raw.type === "choice" && typeof raw.choice === "string") {
    const probabilities = numberEntries(raw.probabilities).map(([value, probability]) => ({ value, probability }));
    const confidence = isFiniteNumber(raw.confidence) ? raw.confidence : top(probabilities, 1);
    return { type: "choice", name, choice: raw.choice, confidence, probabilities };
  }
  if (question.type === "score" && raw.type === "score" && isFiniteNumber(raw.score)) {
    // OpenRouter keys a score's probabilities by level index ("0", "1", …) in the order of `criteria`.
    const probabilities = numberEntries(raw.probabilities).flatMap(([key, probability]) => {
      const level = question.levels[Number(key)];
      return level ? [{ label: level.label, value: Number(key), probability }] : [];
    });
    const nearest = question.levels[Math.round(raw.score)];
    const confidence = isFiniteNumber(raw.confidence) ? raw.confidence : top(probabilities, 1);
    return {
      type: "score",
      name,
      score: raw.score,
      confidence,
      probabilities: probabilities.length > 0 || !nearest
        ? probabilities
        : [{ label: nearest.label, value: Math.round(raw.score), probability: 1 }],
    };
  }
  return { type: raw.type, name };
}

/** OpenRouter's response in the shape of docs/decisions-api.md, answers in question order. */
export function fromOpenRouterResponse(body: unknown, request: DecisionsRequest): unknown {
  if (!isRecord(body) || !isRecord(body.answers) || !isRecord(body.usage)) throw new ModelError("invalid response");
  const { answers, usage } = body;
  const inputTokens = usage.input_tokens;
  const outputTokens = isFiniteNumber(usage.output_tokens) ? usage.output_tokens : 0;
  return {
    model: body.model,
    answers: request.questions.map((question) => fromAnswer(question, answers[question.name])),
    usage: {
      input_tokens: inputTokens,
      // OpenRouter reports no prompt caching for decision models.
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: isFiniteNumber(inputTokens) ? inputTokens + outputTokens : outputTokens,
    },
  };
}

export function createOpenRouterClient(apiKey: string, model: string, fetchFn: typeof fetch = fetch): DecisionsClient {
  const post = async (request: DecisionsRequest) =>
    fromOpenRouterResponse(
      await postJson(OPENROUTER_DECISIONS_URL, apiKey, toOpenRouterRequest(request, model), fetchFn),
      request,
    );
  return { mode: "live", model, decide: post, refine: post };
}
