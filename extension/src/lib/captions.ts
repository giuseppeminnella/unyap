// Pure helpers for capturing a transcript from the player's own caption request (docs/youtube-transcripts.md).
import type { TranscriptLine } from "../../../shared/types.ts";

/** A caption track as the player response and the player's tracklist describe it. */
export interface CaptionTrack {
  languageCode: string;
  kind?: string;
}

function isAsr(track: CaptionTrack): boolean {
  return track.kind === "asr";
}

function primaryLanguage(languageCode: string): string {
  return languageCode.toLowerCase().replace(/-.*$/, "");
}

/** An audio track of the video: the indices into `captionTracks` that go with it, the player's default first. */
export interface AudioTrack {
  captionTrackIndices?: number[];
  defaultCaptionTrackIndex?: number;
}

/** The player response's `captions.playerCaptionsTracklistRenderer`. */
export interface CaptionTracklist {
  captionTracks?: CaptionTrack[];
  audioTracks?: AudioTrack[];
  defaultAudioTrackIndex?: number;
}

/**
 * The track the player names for the default audio track (its `defaultCaptionTrackIndex`, else the first of its
 * `captionTrackIndices`): `captionTracks` can start with auto-translated asr tracks in other languages.
 * Without that: a manual track in the auto-generated track's language, else the auto-generated track, else the first.
 */
export function chooseTrack(tracklist: CaptionTracklist): CaptionTrack | null {
  const tracks = tracklist.captionTracks ?? [];
  const audio = tracklist.audioTracks?.[tracklist.defaultAudioTrackIndex ?? 0];
  for (const index of [audio?.defaultCaptionTrackIndex, audio?.captionTrackIndices?.[0]]) {
    const track = index === undefined ? undefined : tracks[index];
    if (track) return track;
  }
  const asr = tracks.find(isAsr);
  if (!asr) return tracks[0] ?? null;
  const language = primaryLanguage(asr.languageCode);
  return tracks.find((track) => !isAsr(track) && primaryLanguage(track.languageCode) === language) ?? asr;
}

/**
 * A timedtext request for this video: "pot" when it carries the proof-of-origin token, "no-pot" when the player sent
 * it before it had one (right after a page load; never refetch it). Null for any other URL.
 */
export function captionRequestKind(raw: string, videoId: string): "pot" | "no-pot" | null {
  const url = URL.parse(raw);
  if (
    url === null ||
    url.origin !== "https://www.youtube.com" ||
    url.pathname !== "/api/timedtext" ||
    url.searchParams.get("v") !== videoId
  ) {
    return null;
  }
  return url.searchParams.get("pot") ? "pot" : "no-pot";
}

/** The last pot-bearing timedtext URL the player requested for this video. */
export function findCaptionUrl(urls: string[], videoId: string): string | null {
  return urls.findLast((raw) => captionRequestKind(raw, videoId) === "pot") ?? null;
}

/** The player's URL rewritten to ask for the whole track as json3; the token parameters stay as they are. */
export function captionJson3Url(url: string, track: CaptionTrack): string {
  const result = new URL(url);
  result.searchParams.set("lang", track.languageCode);
  if (isAsr(track)) result.searchParams.set("kind", "asr");
  else result.searchParams.delete("kind");
  result.searchParams.set("fmt", "json3");
  result.searchParams.delete("tlang");
  return result.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One line per json3 event with text: `{ events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }`. */
export function parseJson3(data: unknown): TranscriptLine[] {
  if (!isRecord(data) || !Array.isArray(data.events)) return [];
  const lines: TranscriptLine[] = [];
  for (const event of data.events) {
    if (!isRecord(event) || !Array.isArray(event.segs) || typeof event.tStartMs !== "number") continue;
    const text = event.segs
      .map((seg) => (isRecord(seg) && typeof seg.utf8 === "string" ? seg.utf8 : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text === "") continue;
    const durationMs = typeof event.dDurationMs === "number" ? event.dDurationMs : 0;
    lines.push({ startMs: event.tStartMs, durationMs, text });
  }
  return lines;
}

/**
 * Whether the player response marks the video private (`videoDetails.isPrivate`) or unlisted
 * (`microformat.playerMicroformatRenderer.isUnlisted`). Only boolean true counts: a missing field means public.
 */
export function isPrivateOrUnlisted(response: unknown): boolean {
  if (!isRecord(response)) return false;
  const { videoDetails, microformat } = response;
  const renderer = isRecord(microformat) ? microformat.playerMicroformatRenderer : undefined;
  const isPrivate = isRecord(videoDetails) && videoDetails.isPrivate === true;
  return isPrivate || (isRecord(renderer) && renderer.isUnlisted === true);
}
