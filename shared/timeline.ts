// Pure helpers that turn an Analysis into what the extension draws.
import type { Analysis, SubstanceLevel } from "./types.ts";

/** Below this `delivers` probability the video is labelled "Title never delivered". */
export const NEVER_DELIVERED_BELOW = 0.35;
/** Below this payoff confidence the jump button says the point is uncertain. */
export const CONFIDENT_PAYOFF_FROM = 0.4;
/** A substance section starting less than this after the current time counts as already reached. */
export const REACHED_WITHIN_MS = 1000;
/** Previous restarts the current substance section once playback is more than this far into it. */
export const RESTART_AFTER_MS = 3000;

export type Verdict = "delivered" | "uncertain" | "never-delivered";

export interface StripBlock {
  leftPct: number;
  widthPct: number;
  substance: number;
  level: SubstanceLevel;
}

/** A run of consecutive segments with the same level. */
export interface Section {
  level: SubstanceLevel;
  startMs: number;    // startMs of the first segment
  endMs: number;      // endMs of the last segment
  firstIndex: number; // position in analysis.segments of the first segment
  lastIndex: number;  // position in analysis.segments of the last segment
}

/** "4:05" under an hour, "1:02:09" from an hour. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function verdict(analysis: Analysis): Verdict {
  if (analysis.delivers < NEVER_DELIVERED_BELOW || analysis.payoff === null) return "never-delivered";
  return analysis.payoff.confidence >= CONFIDENT_PAYOFF_FROM ? "delivered" : "uncertain";
}

/** One block per segment, positioned as a percentage of the video length. */
export function stripBlocks(analysis: Analysis): StripBlock[] {
  const totalMs = analysis.lengthSeconds * 1000;
  if (totalMs <= 0) return [];
  return analysis.segments.map((segment) => ({
    leftPct: (segment.startMs / totalMs) * 100,
    widthPct: (Math.min(segment.endMs, totalMs) - segment.startMs) / totalMs * 100,
    substance: segment.substance,
    level: segment.level,
  }));
}

/** Where the payoff marker sits, as a percentage of the video length, or null without a payoff. */
export function payoffLeftPct(analysis: Analysis): number | null {
  const totalMs = analysis.lengthSeconds * 1000;
  if (analysis.payoff === null || totalMs <= 0) return null;
  return (analysis.payoff.startMs / totalMs) * 100;
}

/** Merges runs of consecutive segments (in array order) with the same level. */
export function sections(analysis: Analysis): Section[] {
  const result: Section[] = [];
  analysis.segments.forEach((segment, i) => {
    const last = result.at(-1);
    if (last?.level === segment.level) {
      last.endMs = segment.endMs;
      last.lastIndex = i;
    } else {
      const { level, startMs, endMs } = segment;
      result.push({ level, startMs, endMs, firstIndex: i, lastIndex: i });
    }
  });
  return result;
}

function substanceStarts(analysis: Analysis): number[] {
  return sections(analysis).flatMap((section) => (section.level === "substance" ? [section.startMs] : []));
}

/** Start of the next good part (substance section) after `currentMs`, or null when there is none. */
export function nextSubstanceStart(analysis: Analysis, currentMs: number): number | null {
  return substanceStarts(analysis).find((startMs) => startMs > currentMs + REACHED_WITHIN_MS) ?? null;
}

/**
 * Music-player Previous: the current good part's start once more than RESTART_AFTER_MS into it, else the good part
 * before it; from filler or context, the latest good part before. Null when there is none.
 */
export function previousSubstanceStart(analysis: Analysis, currentMs: number): number | null {
  return substanceStarts(analysis).findLast((startMs) => startMs < currentMs - RESTART_AFTER_MS) ?? null;
}
