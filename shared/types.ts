// The types shared by the analysis pipeline and the extension.
// Every timestamp is in milliseconds from the start of the video.

/** One caption line as YouTube's json3 caption format gives it. */
export interface TranscriptLine {
  startMs: number;
  durationMs: number;
  text: string;
}

/** What the pipeline analyzes: one video and its transcript, as page.ts reads them from the player. */
export interface AnalyzeRequest {
  /** 11-character YouTube video id. */
  videoId: string;
  title: string;
  description?: string;
  lengthSeconds: number;
  /** BCP-47 language code of the transcript, e.g. "en". */
  language?: string;
  transcript: TranscriptLine[];
}

/** How much of a segment serves the title's promise. */
export type SubstanceLevel = "filler" | "context" | "substance";

/** A fixed-length window of the transcript that the model judged. */
export interface Segment {
  index: number;
  startMs: number;
  endMs: number;
  /** Probability-weighted substance, 0 (pure filler) to 1 (pure substance). */
  substance: number;
  /** The most likely level. */
  level: SubstanceLevel;
  /** Probability that this segment is where the title's promise is first delivered. */
  payoffProbability: number;
}

/** Where the title's promise is first delivered, when the model found it. */
export interface Payoff {
  startMs: number;
  segmentIndex: number;
  /** The model's confidence in its choice, 0 to 1. */
  confidence: number;
}

/** The analysis of one video: what the extension caches and draws. */
export interface Analysis {
  videoId: string;
  title: string;
  lengthSeconds: number;
  segments: Segment[];
  /** null when the most likely answer is that the title is never delivered. */
  payoff: Payoff | null;
  /** Probability that the video delivers what its title promises at all. */
  delivers: number;
  /** Share of the runtime whose segments are mostly substance (substance >= 0.5). */
  substanceRatio: number;
  model: string;
  /** ISO 8601 time the analysis was produced. */
  createdAt: string;
  /** True when it came from the extension's local cache without calling the model. */
  cached: boolean;
}

/** Safe live diagnostics: counts and timings only, never prompts, transcripts or credentials. */
export type AnalysisProgress = { atMs: number } & (
  | { type: "prepared"; segments: number; plannedQuestions: number }
  | {
    type: "call-start";
    call: "main" | "refine";
    mode: "live" | "mock";
    model: string;
    questions: number;
    choices: number;
  }
  | {
    type: "call-end";
    call: "main" | "refine";
    questions: number;
    latencyMs: number;
    inputTokens: number;
    cachedTokens: number;
    refusals: number;
  }
  | { type: "call-error"; call: "main" | "refine"; error: string }
  | { type: "refine-skipped"; reason: "no-payoff" | "too-few-lines" }
);
