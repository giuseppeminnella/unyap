// MAIN-world content script: captures the transcript of the video on a watch page from the player's own caption
// request (docs/youtube-transcripts.md) and hands it to content.ts. No chrome.* APIs exist in this world.
import type { AnalyzeRequest, TranscriptLine } from "../../shared/types.ts";
import {
  captionJson3Url,
  captionRequestKind,
  chooseTrack,
  findCaptionUrl,
  isPrivateOrUnlisted,
  parseJson3,
  type CaptionTrack,
  type CaptionTracklist,
} from "./lib/captions.ts";
import { CAPTURE_EVENT, SKIP_CAPTURE_EVENT, START_CAPTURE_EVENT, watchVideoId, type CaptureMessage } from "./lib/messages.ts";

// Every YouTube selector, event and player method this script relies on.
const YT = {
  player: "#movie_player",
  ccButton: ".ytp-subtitles-button",
  adShowingClass: "ad-showing",
  getPlayerResponse: "getPlayerResponse",
  loadModule: "loadModule",
  unloadModule: "unloadModule",
  getOption: "getOption",
  setOption: "setOption",
  captionsModule: "captions",
  tracklistOption: "tracklist",
  trackOption: "track",
} as const;

const POLL_MS = 100;
const CAPTION_URL_TIMEOUT_MS = 10_000;
const CAPTURE_TIMEOUT_MS = 90_000;
// At most this many json3 refetches: one is sometimes empty right after page load, and a fresh request then works.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;
// Right after a page load the player's caption requests carry no pot (measured: until ~9 s); ask again until one does.
// Those retries wait only briefly for the request, so captions are forced on for short windows.
const TOKEN_WAIT_MS = 30_000;
const TOKEN_RETRY_DELAY_MS = 2_000;
const TOKEN_RETRY_URL_TIMEOUT_MS = 3_000;

interface PlayerResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
    lengthSeconds?: string;
    shortDescription?: string;
    isPrivate?: boolean;
  };
  microformat?: { playerMicroformatRenderer?: { isUnlisted?: boolean } };
  captions?: { playerCaptionsTracklistRenderer?: CaptionTracklist };
}

interface Player extends HTMLElement {
  [YT.getPlayerResponse]?: () => PlayerResponse | undefined;
  [YT.loadModule]: (module: string) => void;
  [YT.unloadModule]: (module: string) => void;
  [YT.getOption]: (module: string, option: string) => unknown;
  [YT.setOption]: (module: string, option: string, value: unknown) => void;
}

/** The URL now shows another video: stop, restore captions, emit nothing. */
class Abandoned extends Error {}

// Set by content.ts when this video's analysis is already cached: the capture stops and touches nothing more.
let skippedVideoId: string | null = null;
document.addEventListener(SKIP_CAPTURE_EVENT, (event) => {
  if (event instanceof CustomEvent && typeof event.detail === "string") skippedVideoId = event.detail;
});

function ensureCurrent(videoId: string): void {
  if (watchVideoId(location) !== videoId || skippedVideoId === videoId) throw new Abandoned();
}

/** Polls `check` until it returns a value or `until` passes (null). Throws Abandoned when the video changes. */
async function waitFor<T>(videoId: string, until: number, check: () => T | null): Promise<T | null> {
  for (;;) {
    ensureCurrent(videoId);
    const value = check();
    if (value !== null) return value;
    if (Date.now() >= until) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function readyPlayer(videoId: string): { player: Player; response: PlayerResponse } | null {
  const player = document.querySelector<Player>(YT.player);
  const getPlayerResponse = player?.[YT.getPlayerResponse];
  if (!player || player.classList.contains(YT.adShowingClass) || typeof getPlayerResponse !== "function") return null;
  const response = getPlayerResponse.call(player);
  return response?.videoDetails?.videoId === videoId ? { player, response } : null;
}

function captionsOn(player: Player): boolean {
  return player.querySelector(YT.ccButton)?.getAttribute("aria-pressed") === "true";
}

/** The player's own tracklist entry for the chosen track, else its first entry, else the bare language. */
function triggerTrack(player: Player, track: CaptionTrack): unknown {
  const list = player[YT.getOption](YT.captionsModule, YT.tracklistOption);
  const tracks: CaptionTrack[] = Array.isArray(list) ? list : [];
  const isAsr = (candidate: CaptionTrack) => candidate.kind === "asr";
  return (
    tracks.find((entry) => entry.languageCode === track.languageCode && isAsr(entry) === isAsr(track)) ??
    tracks[0] ?? { languageCode: track.languageCode }
  );
}

/** A track the player can be set back to: an object with a non-empty `languageCode`. */
function isSelectedTrack(track: unknown): boolean {
  return (
    typeof track === "object" &&
    track !== null &&
    "languageCode" in track &&
    typeof track.languageCode === "string" &&
    track.languageCode !== ""
  );
}

async function fetchLines(url: string, deadline: number): Promise<TranscriptLine[]> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)) });
    const body = await response.text();
    return response.ok && body.trim() !== "" ? parseJson3(JSON.parse(body)) : [];
  } catch {
    return [];
  }
}

/**
 * One try: find the player's pot-bearing caption request (making the player send one when there is none yet),
 * refetch it as json3, and switch captions back off if this try switched them on, or set the user's track back if
 * captions were on and this try selected its own.
 * "no-url" when the player sent no request in time or sent it without a pot (no token yet); [] when the refetch gave
 * no lines.
 */
async function attempt(
  player: Player,
  videoId: string,
  track: CaptionTrack,
  buffered: boolean,
  urlTimeoutMs: number,
  deadline: number,
): Promise<TranscriptLine[] | "no-url"> {
  const urls: string[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) urls.push(entry.name);
  });
  observer.observe({ type: "resource", buffered });
  for (const entry of observer.takeRecords()) urls.push(entry.name);
  let turnedOn = false;
  let saved: unknown = null;
  try {
    let url = findCaptionUrl(urls, videoId);
    if (url === null) {
      turnedOn = !captionsOn(player);
      if (!turnedOn) saved = player[YT.getOption](YT.captionsModule, YT.trackOption);
      const sent = urls.length;
      player[YT.loadModule](YT.captionsModule);
      // Selecting the track that is already showing sends no request, and switching captions off changes the
      // viewer's saved preference: ask for a translation instead. The refetch drops `tlang`, and the finally
      // block sets the viewer's own track back.
      const trigger = triggerTrack(player, track);
      const translateTo = track.languageCode.toLowerCase().startsWith("en") ? "de" : "en";
      player[YT.setOption](
        YT.captionsModule,
        YT.trackOption,
        turnedOn ? trigger : { ...(trigger as object), translationLanguage: { languageCode: translateTo } },
      );
      const until = Math.min(Date.now() + urlTimeoutMs, deadline);
      const found = await waitFor(videoId, until, () => {
        const latest = findCaptionUrl(urls, videoId);
        if (latest !== null) return { url: latest };
        // A request without a pot ends this try: the player has no token yet.
        const tokenless = urls.slice(sent).some((raw) => captionRequestKind(raw, videoId) === "no-pot");
        return tokenless ? { url: null } : null;
      });
      if (!found?.url) return "no-url";
      url = found.url;
    }
    const lines = await fetchLines(captionJson3Url(url, track), deadline);
    ensureCurrent(videoId);
    return lines;
  } finally {
    observer.disconnect();
    if (turnedOn) {
      player[YT.setOption](YT.captionsModule, YT.trackOption, {});
      player[YT.unloadModule](YT.captionsModule);
    } else if (isSelectedTrack(saved)) {
      player[YT.setOption](YT.captionsModule, YT.trackOption, saved);
    }
  }
}

/** Hands a message to content.ts, unless the URL already shows another video. */
function send(videoId: string, message: CaptureMessage): void {
  if (watchVideoId(location) !== videoId) return;
  document.dispatchEvent(new CustomEvent(CAPTURE_EVENT, { detail: JSON.stringify(message) }));
}

/** The final message for this video. While it waits for the player's caption token it sends one "waiting" message. */
async function capture(videoId: string, deadline: number): Promise<CaptureMessage> {
  const tokenUntil = Math.min(Date.now() + TOKEN_WAIT_MS, deadline);
  const ready = await waitFor(videoId, deadline, () => readyPlayer(videoId));
  if (ready === null) return { type: "capture-failed", videoId };
  const { player, response } = ready;
  const details = response.videoDetails ?? {};
  const lengthSeconds = Number(details.lengthSeconds);
  if (!(lengthSeconds >= 1)) return { type: "unsupported", videoId };
  if (isPrivateOrUnlisted(response)) return { type: "not-public", videoId };
  const track = chooseTrack(response.captions?.playerCaptionsTracklistRenderer ?? {});
  if (track === null) return { type: "no-transcript", videoId };

  let refetches = 0;
  let noUrl = false;
  let waiting = false;
  for (let tries = 1; ; tries++) {
    // Retries only look at new entries, so a stale request (or our own refetch) is never reused.
    const urlTimeoutMs = noUrl ? TOKEN_RETRY_URL_TIMEOUT_MS : CAPTION_URL_TIMEOUT_MS;
    const lines = await attempt(player, videoId, track, tries === 1, urlTimeoutMs, deadline);
    if (lines !== "no-url" && lines.length > 0) {
      const request: AnalyzeRequest = {
        videoId,
        title: details.title ?? "",
        ...(details.shortDescription ? { description: details.shortDescription } : {}),
        lengthSeconds,
        language: track.languageCode,
        transcript: lines,
      };
      return { type: "transcript", request };
    }
    noUrl = lines === "no-url";
    if (!noUrl) refetches++;
    if ((noUrl ? Date.now() >= tokenUntil : refetches === MAX_ATTEMPTS) || Date.now() >= deadline) {
      return { type: "capture-failed", videoId };
    }
    // The token wait can take seconds while the player visibly switches captions: say that something is happening.
    if (noUrl && !waiting) {
      waiting = true;
      send(videoId, { type: "waiting", videoId });
    }
    await waitFor(videoId, Date.now() + (noUrl ? TOKEN_RETRY_DELAY_MS : RETRY_DELAY_MS), () => null);
  }
}

/** YouTube remembers the viewer's captions on/off choice here; a capture toggling captions must not change it. */
const CAPTION_PREFERENCE_KEY = "yt-player-caption-persistence";
const CAPTION_RESTORE_RECHECK_MS = [500, 1500, 3000];

function readCaptionPreference(): string | null {
  try {
    return localStorage.getItem(CAPTION_PREFERENCE_KEY);
  } catch {
    return null;
  }
}

/**
 * Puts the viewer's caption preference back as it was before the capture. YouTube applies a saved "on" a moment
 * after load, so a capture can start before it and switch captions off at the end: switch them back on then.
 */
function restoreCaptionPreference(before: string | null, videoId: string): void {
  try {
    if (readCaptionPreference() === before) return;
    if (before === null) localStorage.removeItem(CAPTION_PREFERENCE_KEY);
    else localStorage.setItem(CAPTION_PREFERENCE_KEY, before);
    const wantsCaptions = before !== null && (JSON.parse(before) as { data?: unknown }).data === "true";
    const player = document.querySelector<Player>(YT.player);
    if (wantsCaptions && player && watchVideoId(location) === videoId && !captionsOn(player)) {
      const tracks = player[YT.getOption](YT.captionsModule, YT.tracklistOption);
      player[YT.loadModule](YT.captionsModule);
      const first: unknown = Array.isArray(tracks) ? tracks[0] : undefined;
      if (first !== undefined) player[YT.setOption](YT.captionsModule, YT.trackOption, first);
    }
  } catch {
    // Storage blocked or an unexpected value: leave YouTube's own state alone.
  }
}

async function run(videoId: string): Promise<void> {
  const preference = readCaptionPreference();
  let message: CaptureMessage | null;
  try {
    message = await capture(videoId, Date.now() + CAPTURE_TIMEOUT_MS);
  } catch (error) {
    message = error instanceof Abandoned ? null : { type: "capture-failed", videoId };
  } finally {
    restoreCaptionPreference(preference, videoId);
    // YouTube saves the preference with a delay, so its write from our toggling can land after the restore.
    for (const delayMs of CAPTION_RESTORE_RECHECK_MS) {
      setTimeout(() => restoreCaptionPreference(preference, videoId), delayMs);
    }
  }
  if (message !== null) send(videoId, message);
}

// Captures run only when content.ts asks (the viewer's click, or auto mode), one after another, one at a time per video.
let queue = Promise.resolve();
let runningVideoId: string | null = null;

document.addEventListener(START_CAPTURE_EVENT, (event) => {
  if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
  const videoId: string = event.detail;
  if (videoId !== watchVideoId(location) || videoId === runningVideoId) return;
  if (skippedVideoId === videoId) skippedVideoId = null;
  runningVideoId = videoId;
  queue = queue.then(() => run(videoId)).finally(() => {
    if (runningVideoId === videoId) runningVideoId = null;
  });
});
