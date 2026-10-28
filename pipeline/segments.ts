import type { AnalyzeRequest, TranscriptLine } from "../shared/types.ts";

/** The text of a segment nobody speaks in. */
export const NO_SPEECH = "(no speech)";

/** The Decisions API accepts at most 255 choices per question. */
const MAX_REFINEMENT_LINES = 255;

/** One window of the transcript, as the model sees it. */
export interface SegmentText {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export function lengthMsOf(lengthSeconds: number): number {
  return Math.round(lengthSeconds * 1000);
}

/** The segment length L: at least 30 s, and long enough for at most 120 segments. */
export function windowMsOf(lengthMs: number): number {
  return Math.max(30_000, Math.ceil(lengthMs / 120));
}

/** Caption text on one line: runs of whitespace become one space. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Splits the video into at most 120 windows of at least 30 s and gives each the text spoken in it. */
export function segmentTranscript(request: AnalyzeRequest): SegmentText[] {
  const lengthMs = lengthMsOf(request.lengthSeconds);
  const windowMs = windowMsOf(lengthMs);
  const count = Math.ceil(lengthMs / windowMs);
  const texts: string[][] = Array.from({ length: count }, () => []);
  for (const line of request.transcript) {
    // Captions often start just past the rounded length; keep them in the last window.
    texts[Math.min(Math.floor(line.startMs / windowMs), count - 1)]?.push(line.text);
  }
  return texts.map((lines, index) => ({
    index,
    startMs: index * windowMs,
    endMs: Math.min((index + 1) * windowMs, lengthMs),
    text: collapseWhitespace(lines.join(" ")) || NO_SPEECH,
  }));
}

/**
 * The transcript lines starting in segment k or the one before it, in transcript order. Past 255 lines it keeps the
 * ones closest to the start of segment k, the earlier one on a tie.
 */
export function refinementLines(request: AnalyzeRequest, segmentIndex: number): TranscriptLine[] {
  const windowMs = windowMsOf(lengthMsOf(request.lengthSeconds));
  const startMs = segmentIndex * windowMs;
  const lines = request.transcript.filter(
    (line) => line.startMs >= startMs - windowMs && line.startMs < startMs + windowMs,
  );
  if (lines.length <= MAX_REFINEMENT_LINES) return lines;
  const kept = new Set(
    lines
      .map((line, order) => ({ order, distance: Math.abs(line.startMs - startMs) }))
      .sort((a, b) => a.distance - b.distance || a.order - b.order)
      .slice(0, MAX_REFINEMENT_LINES)
      .map(({ order }) => order),
  );
  return lines.filter((_, order) => kept.has(order));
}
