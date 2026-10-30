// Validation at the extension boundary: a script in the YouTube page can send content.ts any capture message, and
// the worker is the last place that decides what reaches the prompt. Over-long text is truncated; a malformed request
// is refused.
import type { AnalyzeRequest, TranscriptLine } from "./types.ts";

/** The largest capture message content.ts will parse at all. */
export const MAX_CAPTURE_JSON_CHARS = 12 * 1024 * 1024;
export const MAX_TITLE_CHARS = 1000;
/** The prompt itself reads at most this much of the description. */
export const MAX_DESCRIPTION_CHARS = 1000;
export const MAX_LANGUAGE_CHARS = 35;
export const MAX_TRANSCRIPT_LINES = 100_000;
/** Still under the Decisions API's 10 MiB text part, and far above any real video's captions. */
export const MAX_TRANSCRIPT_CHARS = 8_000_000;
/** YouTube's longer regular videos are under this; it keeps the segment math sane. */
export const MAX_LENGTH_SECONDS = 24 * 60 * 60;
/** A caption line may start a little past the rounded video length. */
export const MAX_CAPTION_START_MS = (MAX_LENGTH_SECONDS + 60) * 1000;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A valid AnalyzeRequest, with over-long text truncated, or null when it is malformed. */
export function parseAnalyzeRequest(value: unknown): AnalyzeRequest | null {
  if (!isRecord(value)) return null;
  const { videoId, title, description, lengthSeconds, language, transcript } = value;
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) return null;
  if (typeof title !== "string") return null;
  if (!isFiniteNumber(lengthSeconds) || lengthSeconds < 1 || lengthSeconds > MAX_LENGTH_SECONDS) return null;
  if (description !== undefined && typeof description !== "string") return null;
  if (language !== undefined && typeof language !== "string") return null;
  if (!Array.isArray(transcript) || transcript.length === 0 || transcript.length > MAX_TRANSCRIPT_LINES) return null;

  const lines: TranscriptLine[] = [];
  let textChars = 0;
  for (const raw of transcript) {
    if (!isRecord(raw)) return null;
    const { startMs, durationMs, text } = raw;
    if (!isFiniteNumber(startMs) || startMs < 0 || startMs > MAX_CAPTION_START_MS) return null;
    if (!isFiniteNumber(durationMs) || durationMs < 0 || durationMs > MAX_CAPTION_START_MS) return null;
    if (typeof text !== "string") return null;
    textChars += text.length;
    if (textChars > MAX_TRANSCRIPT_CHARS) return null;
    lines.push({ startMs, durationMs, text });
  }

  return {
    videoId,
    title: title.slice(0, MAX_TITLE_CHARS),
    ...(description !== undefined ? { description: description.slice(0, MAX_DESCRIPTION_CHARS) } : {}),
    lengthSeconds,
    ...(language !== undefined ? { language: language.slice(0, MAX_LANGUAGE_CHARS) } : {}),
    transcript: lines,
  };
}
