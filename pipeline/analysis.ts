// The analysis pipeline: segment, ask, refine the payoff, map, log.
import type {
  Analysis, AnalysisProgress, AnalyzeRequest, Payoff, Segment, SubstanceLevel, TranscriptLine,
} from "../shared/types.ts";
import {
  buildDecisionsRequest,
  buildRefinementRequest,
  type DecisionsClient,
  type DecisionsMode,
  lineName,
  ModelError,
  scoreName,
  segmentName,
} from "./decisions.ts";
import { lengthMsOf, refinementLines, segmentTranscript, type SegmentText } from "./segments.ts";
import { isFiniteNumber, isRecord } from "./guards.ts";

const LEVELS: readonly SubstanceLevel[] = ["filler", "context", "substance"];

interface CallCounts {
  /** Names of the refused questions, in question order. */
  refusals: string[];
  inputTokens: number;
  cachedTokens: number;
}

export interface MappedResponse extends CallCounts {
  analysis: Omit<Analysis, "createdAt" | "cached">;
}

export interface MappedRefinement extends CallCounts {
  /** The chosen line's startMs; null when `start` was refused. */
  startMs: number | null;
}

export interface CallLog {
  event: "decisions_call";
  /** Only on the refinement call. */
  call?: "refine";
  mode: DecisionsMode;
  videoId: string;
  segments: number;
  /** Only on the refinement call: the number of lines it chose from. */
  lines?: number;
  latencyMs: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  refusals: string[];
  ok: boolean;
  error?: string;
}

function invalid(): never {
  throw new ModelError("invalid response");
}

function num(value: unknown): number {
  return isFiniteNumber(value) ? value : invalid();
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid();
}

/** The label with the highest probability, the first one on a tie. */
function topLevel(probabilities: unknown[]): SubstanceLevel {
  let best: { level: SubstanceLevel; probability: number } | undefined;
  for (const entry of probabilities) {
    if (!isRecord(entry)) invalid();
    const level = LEVELS.find((label) => label === entry.label) ?? invalid();
    const probability = num(entry.probability);
    if (!best || probability > best.probability) best = { level, probability };
  }
  return best?.level ?? invalid();
}

interface ResponseReader extends CallCounts {
  model: string;
  /** The answer named `name`, or undefined when it was refused (recorded in `refusals`). */
  answer(name: string, type: string): Record<string, unknown> | undefined;
}

/** Checks what every Decisions response has: a model, usage and a list of answers. */
function readResponse(response: unknown): ResponseReader {
  if (!isRecord(response) || typeof response.model !== "string") invalid();
  const { usage } = response;
  if (!isRecord(usage) || !isRecord(usage.input_tokens_details)) invalid();
  const inputTokens = num(usage.input_tokens);
  const cachedTokens = num(usage.input_tokens_details.cached_tokens);

  const byName = new Map<string, Record<string, unknown>>();
  for (const answer of list(response.answers)) {
    if (isRecord(answer) && typeof answer.name === "string") byName.set(answer.name, answer);
  }
  const refusals: string[] = [];
  // undefined when refused; any other type than the one asked for is a broken response.
  const answer = (name: string, type: string): Record<string, unknown> | undefined => {
    const found = byName.get(name);
    if (found?.type === "refusal") {
      refusals.push(name);
      return undefined;
    }
    return found?.type === type ? found : invalid();
  };
  return { model: response.model, refusals, inputTokens, cachedTokens, answer };
}

/** Turns a Decisions response into an analysis; throws ModelError("invalid response") when it is not what was asked. */
export function mapResponse(
  response: unknown,
  request: AnalyzeRequest,
  segments: readonly SegmentText[],
): MappedResponse {
  const { model, answer, refusals, inputTokens, cachedTokens } = readResponse(response);

  const deliversAnswer = answer("delivers", "predicate");
  const delivers = deliversAnswer ? num(deliversAnswer.probability) : 0.5;

  const payoffAnswer = answer("payoff", "choice");
  const payoffProbabilities = new Map<string, number>();
  let payoff: Payoff | null = null;
  if (payoffAnswer) {
    for (const entry of list(payoffAnswer.probabilities)) {
      if (!isRecord(entry) || typeof entry.value !== "string") invalid();
      payoffProbabilities.set(entry.value, num(entry.probability));
    }
    const confidence = num(payoffAnswer.confidence);
    if (payoffAnswer.choice !== "none") {
      const chosen = segments.find((segment) => segmentName(segment.index) === payoffAnswer.choice) ?? invalid();
      payoff = { startMs: chosen.startMs, segmentIndex: chosen.index, confidence };
    }
  }

  const mapped = segments.map((segment): Segment => {
    const score = answer(scoreName(segment.index), "score");
    return {
      index: segment.index,
      startMs: segment.startMs,
      endMs: segment.endMs,
      substance: score ? num(score.score) / 2 : 0.5,
      level: score ? topLevel(list(score.probabilities)) : "context",
      payoffProbability: payoffProbabilities.get(segmentName(segment.index)) ?? 0,
    };
  });
  const substantialMs = mapped
    .filter((segment) => segment.substance >= 0.5)
    .reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);

  return {
    analysis: {
      videoId: request.videoId,
      title: request.title,
      lengthSeconds: request.lengthSeconds,
      segments: mapped,
      payoff,
      delivers,
      substanceRatio: substantialMs / lengthMsOf(request.lengthSeconds),
      model,
    },
    refusals,
    inputTokens,
    cachedTokens,
  };
}

/** Reads the refinement response; throws ModelError("invalid response") when `start` is not one of the lines. */
export function mapRefinement(response: unknown, lines: readonly TranscriptLine[]): MappedRefinement {
  const { answer, refusals, inputTokens, cachedTokens } = readResponse(response);
  const start = answer("start", "choice");
  const startMs = start ? (lines.find((_, i) => lineName(i) === start.choice) ?? invalid()).startMs : null;
  return { startMs, refusals, inputTokens, cachedTokens };
}

export type ProgressListener = (event: AnalysisProgress) => void;

/** The default call log: one JSON line per model call on stdout (tests and scripts; the extension passes its own). */
export function logCall(line: CallLog): void {
  console.log(JSON.stringify(line));
}

/**
 * Segments, asks, refines and maps one analysis, without caching (the extension caches it locally). `log` receives
 * one line per model call.
 */
export async function runAnalysis(
  client: DecisionsClient, request: AnalyzeRequest, emit: ProgressListener = () => {},
  log: (line: CallLog) => void = logCall,
): Promise<Analysis> {
  /** Makes one model call, maps its response and logs it; a failure is logged and rethrown. */
  async function logged<T extends CallCounts>(
    call: Pick<CallLog, "event" | "call" | "mode" | "videoId" | "segments" | "lines">,
    send: () => Promise<unknown>,
    map: (response: unknown) => T,
    emit: ProgressListener,
    info: { call: "main" | "refine"; model: string; questions: number; choices: number },
  ): Promise<T> {
    const started = performance.now();
    let latencyMs = 0;
    emit({ type: "call-start", atMs: Date.now(), mode: client.mode, ...info });
    try {
      const response = await send().finally(() => {
        latencyMs = Math.round(performance.now() - started);
      });
      const mapped = map(response);
      const { inputTokens, cachedTokens, refusals } = mapped;
      log({ ...call, latencyMs, inputTokens, cachedTokens, refusals, ok: true });
      emit({
        type: "call-end", atMs: Date.now(), call: info.call, questions: info.questions,
        latencyMs, inputTokens, cachedTokens, refusals: refusals.length,
      });
      return mapped;
    } catch (error) {
      const reason = error instanceof ModelError ? error.reason : "internal error";
      log({ ...call, latencyMs, inputTokens: null, cachedTokens: null, refusals: [], ok: false, error: reason });
      emit({ type: "call-error", atMs: Date.now(), call: info.call, error: reason });
      throw error;
    }
  }

  function ask(request: AnalyzeRequest, segments: SegmentText[], emit: ProgressListener): Promise<MappedResponse> {
    const call = {
      event: "decisions_call",
      mode: client.mode,
      videoId: request.videoId,
      segments: segments.length,
    } as const;
    const body = buildDecisionsRequest(request, segments);
    return logged(
      call,
      () => client.decide(body, segments),
      (response) => mapResponse(response, request, segments),
      emit,
      { call: "main", model: body.model, questions: body.questions.length, choices: segments.length + 1 },
    );
  }

  /** Moves the payoff to the line the second call picks; a model failure or refusal keeps the segment start. */
  async function refine(
    request: AnalyzeRequest, segments: SegmentText[], payoff: Payoff, emit: ProgressListener,
  ): Promise<Payoff> {
    const lines = refinementLines(request, payoff.segmentIndex);
    if (lines.length < 2) {
      emit({ type: "refine-skipped", atMs: Date.now(), reason: "too-few-lines" });
      return payoff;
    }
    const call = {
      event: "decisions_call",
      call: "refine",
      mode: client.mode,
      videoId: request.videoId,
      segments: segments.length,
      lines: lines.length,
    } as const;
    const body = buildRefinementRequest(request, lines);
    try {
      const { startMs } = await logged(
        call,
        () => client.refine(body, lines),
        (response) => mapRefinement(response, lines),
        emit,
        { call: "refine", model: body.model, questions: body.questions.length, choices: lines.length },
      );
      return startMs === null ? payoff : { ...payoff, startMs };
    } catch (error) {
      if (error instanceof ModelError) return payoff;
      throw error;
    }
  }

  const segments = segmentTranscript(request);
  emit({ type: "prepared", atMs: Date.now(), segments: segments.length, plannedQuestions: segments.length + 3 });
  const { analysis } = await ask(request, segments, emit);
  if (!analysis.payoff) emit({ type: "refine-skipped", atMs: Date.now(), reason: "no-payoff" });
  const payoff = analysis.payoff && (await refine(request, segments, analysis.payoff, emit));
  return { ...analysis, payoff, createdAt: new Date().toISOString(), cached: false };
}
