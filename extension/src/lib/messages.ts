// What the extension's scripts say to each other: page.ts → content.ts through a CustomEvent on `document`,
// content.ts → background.ts through chrome.runtime messages.
import type { Analysis, AnalysisProgress, AnalyzeRequest } from "../../../shared/types.ts";

/** Dispatched by page.ts on `document`. Its detail is a JSON-encoded CaptureMessage: objects do not cross JS worlds. */
export const CAPTURE_EVENT = "unyap:capture";

export type CaptureMessage =
  | { type: "transcript"; request: AnalyzeRequest }
  | { type: "no-transcript"; videoId: string }
  | { type: "capture-failed"; videoId: string }
  // Private or unlisted video: never captured or sent.
  | { type: "not-public"; videoId: string }
  // Still capturing: the player has no caption token yet. One of the messages above follows.
  | { type: "waiting"; videoId: string };

export type WorkerMessage =
  | { type: "analyze"; request: AnalyzeRequest }
  | { type: "cached"; videoId: string }
  | { type: "open-options" };

/** content.ts → page.ts: this video's analysis is already cached, so stop capturing it. */
export const SKIP_CAPTURE_EVENT = "unyap:skip-capture";

/** content.ts → page.ts: capture this video's transcript now (`detail` is the video id). */
export const START_CAPTURE_EVENT = "unyap:start-capture";

/** The service worker's answer to a `cached` message. */
export interface CachedResponse {
  /** The locally cached analysis for the video, or null when there is none or it can't be read. */
  analysis: Analysis | null;
  /** The "Analyze every video automatically" setting. */
  autoAnalyze: boolean;
}

export const ANALYZE_PORT = "unyap:analysis";

export type AnalysisPortMessage =
  | { type: "debug"; enabled: boolean }
  | { type: "progress"; event: AnalysisProgress }
  | { type: "result"; response: AnalyzeResponse };

/** The service worker's answer to an `analyze` message. `message` is the text after "Unyap: ". */
export type AnalyzeResponse =
  | { ok: true; analysis: Analysis }
  | { ok: false; reason: "settings" | "auth" | "network" }
  | { ok: false; reason: "failed"; message: string };

/** The video id of a watch page URL, or null for any other page. */
export function watchVideoId(location: { pathname: string; search: string }): string | null {
  if (location.pathname !== "/watch") return null;
  const videoId = new URLSearchParams(location.search).get("v");
  return videoId !== null && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : null;
}
