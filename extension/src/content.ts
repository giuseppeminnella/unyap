// Isolated-world content script: receives page.ts's capture, asks the service worker for the analysis and draws
// the strip, the payoff marker and the pill in the player.
import {
  formatTime,
  nextSubstanceStart,
  payoffLeftPct,
  previousSubstanceStart,
  sections,
  stripBlocks,
  verdict,
} from "../../shared/timeline.ts";
import type { Analysis, AnalyzeRequest } from "../../shared/types.ts";
import { DebugOverlay } from "./lib/debug-overlay.ts";
import {
  ANALYZE_PORT,
  CAPTURE_EVENT,
  SKIP_CAPTURE_EVENT,
  START_CAPTURE_EVENT,
  watchVideoId,
  type AnalysisPortMessage,
  type AnalyzeResponse,
  type CachedResponse,
  type CaptureMessage,
  type WorkerMessage,
} from "./lib/messages.ts";

// Every YouTube selector and event this script relies on.
const YT = {
  player: "#movie_player",
  chromeBottom: ".ytp-chrome-bottom",
  progressBarContainer: ".ytp-progress-bar-container",
  video: "#movie_player video",
  navigateStartEvent: "yt-navigate-start",
  navigateFinishEvent: "yt-navigate-finish",
} as const;

// The pill sits this far above the progress bar container: the 4 px strip (styles.css) plus a gap.
const PILL_OFFSET_PX = 4 + 8;
// Events that must not reach the player's own handlers (play/pause on click, keyboard shortcuts, fullscreen).
const CONTAINED_EVENTS = [
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "touchstart",
  "touchend",
  "keydown",
  "keyup",
  "keypress",
];

const TEXT = {
  analyzing: "Unyap: analyzing…",
  settings: "Unyap: add your OpenAI API key in the options.",
  auth: "Unyap: OpenAI rejected your API key.",
  network: "Unyap: can't reach OpenAI.",
  noTranscript: "Unyap: this video has no transcript.",
  captureFailed: "Unyap: couldn't read the transcript.",
  notPublic: "Unyap: skipped (private or unlisted video).",
  unsupported: "Unyap: live streams and premieres aren't supported.",
  offer: "Unyap this video",
  retry: "Try again",
  previous: "Previous",
  next: "Next good part",
};

type Display =
  | { kind: "analysis"; analysis: Analysis }
  | { kind: "status"; text: string; options: boolean; dismiss: boolean; retry?: boolean }
  | { kind: "offer" };

/** What Unyap knows about the video the URL shows. Replaced whenever that video changes. */
interface View {
  videoId: string;
  handled: boolean;
  /**
   * A capture was asked for. Until then capture messages are ignored: an analysis starts only from a click or
   * auto mode.
   */
  requested: boolean;
  display: Display | null;
  debug: DebugOverlay | null;
  port: chrome.runtime.Port | null;
}

let view: View | null = null;
let resizeObserver: ResizeObserver | null = null;
// Removes the pill's listeners on the video along with the pill.
let pillListeners: AbortController | null = null;

function status(text: string, options = false): Display {
  return { kind: "status", text, options, dismiss: true };
}

function analyzing(): Display {
  return { kind: "status", text: TEXT.analyzing, options: false, dismiss: false };
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, className: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

async function sendToWorker(message: WorkerMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

function removeUi(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
  pillListeners?.abort();
  pillListeners = null;
  for (const node of document.querySelectorAll(".unyap-strip, .unyap-pill")) node.remove();
}

function syncView(): void {
  const videoId = watchVideoId(location);
  if (view?.videoId === videoId) return;
  removeUi();
  const previous = view;
  view = videoId === null
    ? null
    : { videoId, handled: false, requested: false, display: null, debug: null, port: null };
  previous?.port?.disconnect();
  previous?.debug?.element.remove();
  if (view !== null) void showCached(view);
}

/**
 * Shows the locally cached analysis right away when there is one. Otherwise the transcript is captured on the
 * viewer's click ("Unyap this video"), or at once when "Analyze every video automatically" is on.
 */
async function showCached(target: View): Promise<void> {
  let response: CachedResponse | null = null;
  try {
    response = (await sendToWorker({ type: "cached", videoId: target.videoId })) as CachedResponse | null;
  } catch {
    // The worker is unreachable: still offer the button, the click reports the problem.
  }
  if (view !== target || target.handled) return;
  if (response?.analysis) {
    target.handled = true;
    document.dispatchEvent(new CustomEvent(SKIP_CAPTURE_EVENT, { detail: target.videoId }));
    show(target, { kind: "analysis", analysis: response.analysis });
  } else if (response?.autoAnalyze) {
    startCapture(target);
  } else {
    show(target, { kind: "offer" });
  }
}

/** Asks page.ts to capture this video's transcript; its result arrives as a capture message. */
function startCapture(target: View): void {
  if (view !== target) return;
  target.handled = false;
  target.requested = true;
  show(target, analyzing());
  document.dispatchEvent(new CustomEvent(START_CAPTURE_EVENT, { detail: target.videoId }));
}

function show(target: View, display: Display | null): void {
  if (view !== target) return;
  target.display = display;
  render();
}

function buildStrip(analysis: Analysis): HTMLElement {
  const strip = element("div", "unyap-strip");
  strip.setAttribute("aria-hidden", "true");
  for (const block of stripBlocks(analysis)) {
    const node = element("div", `unyap-block unyap-${block.level}`);
    node.style.left = `${block.leftPct}%`;
    node.style.width = `${block.widthPct}%`;
    strip.append(node);
  }
  const markerPct = payoffLeftPct(analysis);
  if (verdict(analysis) !== "never-delivered" && markerPct !== null) {
    const marker = element("div", "unyap-marker");
    marker.style.left = `${markerPct}%`;
    strip.append(marker);
  }
  return strip;
}

function seek(ms: number): void {
  const video = document.querySelector<HTMLVideoElement>(YT.video);
  if (video) video.currentTime = ms / 1000;
}

function currentMs(): number | null {
  const video = document.querySelector<HTMLVideoElement>(YT.video);
  return video ? video.currentTime * 1000 : null;
}

type Step = (analysis: Analysis, currentMs: number) => number | null;

function buildPill(target: View, display: Display, signal: AbortSignal): HTMLElement {
  const pill = element("div", "unyap-pill");
  for (const type of CONTAINED_EVENTS) pill.addEventListener(type, (event) => event.stopPropagation());

  if (display.kind === "offer") {
    // After a pointer click, focus goes back to the player so YouTube's keys keep working.
    pill.append(button(TEXT.offer, "unyap-jump", (event) => {
      startCapture(target);
      if (event.detail > 0) document.querySelector<HTMLElement>(YT.player)?.focus({ preventScroll: true });
    }));
    return pill;
  }

  if (display.kind === "status") {
    const note = element("div", "unyap-note");
    note.setAttribute("role", "status");
    note.append(element("span", "unyap-note-text", display.text));
    if (display.options) {
      note.append(
        button("Options", "unyap-note-button", () => {
          sendToWorker({ type: "open-options" }).catch(() => {});
        }),
      );
    }
    if (display.retry) note.append(button(TEXT.retry, "unyap-note-button", () => startCapture(target)));
    if (display.dismiss) {
      const dismiss = button("×", "unyap-note-dismiss", () => show(target, null));
      dismiss.setAttribute("aria-label", "Dismiss");
      note.append(dismiss);
    }
    pill.append(note);
    return pill;
  }

  const { analysis } = display;
  // Previous and Next good part, disabled while their step has nowhere to go from the current time.
  const navigation: [HTMLButtonElement, Step][] = [];
  let jump: HTMLButtonElement | null = null;
  const refresh = (): void => {
    const ms = currentMs();
    // Disabling the focused button would drop focus to <body>, so focus moves on first.
    let dropped: HTMLButtonElement | null = null;
    for (const [node, step] of navigation) {
      const disabled = ms === null || step(analysis, ms) === null;
      if (disabled && node === document.activeElement) dropped = node;
      else node.disabled = disabled;
    }
    if (dropped === null) return;
    const other = navigation.find(([node]) => node !== dropped && !node.disabled)?.[0];
    (other ?? jump ?? document.querySelector<HTMLElement>(YT.player))?.focus({ preventScroll: true });
    dropped.disabled = true;
  };
  const seekFromPill = (ms: number): void => {
    seek(ms);
    refresh();
  };

  const result = verdict(analysis);
  const payoff = analysis.payoff;
  if (result === "never-delivered" || payoff === null) {
    const note = element("div", "unyap-note");
    note.append(element("span", "unyap-note-text", "Title never delivered"));
    pill.append(note);
  } else {
    const label = result === "uncertain" ? "Unyap it?" : "Unyap it";
    jump = button(`${label} · ${formatTime(payoff.startMs)}`, "unyap-jump", () => seekFromPill(payoff.startMs));
    if (result === "uncertain") jump.title = "Not sure this is the point";
    pill.append(jump);
  }

  if (!sections(analysis).some((section) => section.level === "substance")) return pill;
  for (const [text, step] of [[TEXT.previous, previousSubstanceStart], [TEXT.next, nextSubstanceStart]] as const) {
    const node = button(text, "unyap-nav", (event) => {
      const ms = currentMs();
      const targetMs = ms === null ? null : step(analysis, ms);
      if (targetMs !== null) seekFromPill(targetMs);
      // After a pointer click, focus goes back to the player: the pill keeps YouTube's keys from it. Enter and Space
      // (detail 0) keep focus here, so the keyboard can skip again.
      if (event.detail > 0) document.querySelector<HTMLElement>(YT.player)?.focus({ preventScroll: true });
    });
    navigation.push([node, step]);
    pill.append(node);
  }
  refresh();
  document.querySelector(YT.video)?.addEventListener("timeupdate", refresh, { signal });
  return pill;
}

/**
 * Lines the pill up with the progress bar: left-aligned with it, just above the strip, never wider than it.
 * Hidden while the bar has no width (background tab, miniplayer): there is no right place for it then.
 */
function placePill(pill: HTMLElement, chromeBottom: Element, container: Element): void {
  const bottomRect = chromeBottom.getBoundingClientRect();
  const barRect = container.getBoundingClientRect();
  if (barRect.width === 0) {
    pill.style.display = "none";
    return;
  }
  // Back to the stylesheet's display, which an ad still hides.
  pill.style.display = "";
  pill.style.left = `${barRect.left - bottomRect.left}px`;
  pill.style.bottom = `${bottomRect.bottom - barRect.top + PILL_OFFSET_PX}px`;
  pill.style.maxWidth = `${barRect.width}px`;
}

function render(): void {
  removeUi();
  if (!view?.display || view.videoId !== watchVideoId(location)) return;
  const player = document.querySelector(YT.player);
  if (!player) return;
  if (view.debug && view.debug.element.parentElement !== player) player.append(view.debug.element);
  const chromeBottom = player?.querySelector(YT.chromeBottom);
  const container = chromeBottom?.querySelector(YT.progressBarContainer);
  if (!player || !chromeBottom || !container) return;

  if (view.display.kind === "analysis") container.append(buildStrip(view.display.analysis));
  pillListeners = new AbortController();
  const pill = buildPill(view, view.display, pillListeners.signal);
  chromeBottom.append(pill);
  placePill(pill, chromeBottom, container);
  resizeObserver = new ResizeObserver(() => placePill(pill, chromeBottom, container));
  resizeObserver.observe(player);
  // The bar can get its width without the player resizing.
  resizeObserver.observe(container);
}

function responseDisplay(response: AnalyzeResponse | undefined): Display {
  if (response === undefined) return status(TEXT.network);
  if (response.ok) return { kind: "analysis", analysis: response.analysis };
  switch (response.reason) {
    case "settings":
      return status(TEXT.settings, true);
    case "auth":
      return status(TEXT.auth, true);
    case "network":
      return status(TEXT.network);
    case "failed":
      return status(`Unyap: ${response.message}`);
  }
}

function analyze(target: View, request: AnalyzeRequest): void {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: ANALYZE_PORT });
  } catch {
    show(target, responseDisplay(undefined));
    return;
  }
  target.port = port;
  let finished = false;
  const finish = (response: AnalyzeResponse | undefined) => {
    if (finished) return;
    finished = true;
    target.port = null;
    if (view === target) {
      const display = responseDisplay(response);
      target.debug?.finish(response?.ok ? response.analysis : null, display.kind === "status" ? display.text : undefined);
      show(target, display);
    }
    port.disconnect();
  };
  port.onMessage.addListener((message: AnalysisPortMessage) => {
    if (view !== target || finished) return;
    if (message.type === "debug" && message.enabled) {
      target.debug = new DebugOverlay();
      for (const type of CONTAINED_EVENTS) {
        target.debug.element.addEventListener(type, (event) => event.stopPropagation());
      }
      render();
    } else if (message.type === "progress") target.debug?.progress(message.event);
    else if (message.type === "result") finish(message.response);
  });
  port.onDisconnect.addListener(() => {
    // Read lastError so a worker restart is handled rather than emitted as an unchecked Chrome error.
    void chrome.runtime.lastError;
    finish(undefined);
  });
  try { port.postMessage({ type: "analyze", request }); } catch { finish(undefined); }
}

function parseCaptureMessage(detail: string): CaptureMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(detail);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (
    (message.type === "no-transcript" ||
      message.type === "capture-failed" ||
      message.type === "not-public" ||
      message.type === "unsupported" ||
      message.type === "waiting") &&
    typeof message.videoId === "string"
  ) {
    return { type: message.type, videoId: message.videoId };
  }
  const request = message.request as Record<string, unknown> | null | undefined;
  if (
    message.type === "transcript" &&
    typeof request === "object" &&
    request !== null &&
    typeof request.videoId === "string" &&
    typeof request.title === "string" &&
    typeof request.lengthSeconds === "number" &&
    Array.isArray(request.transcript)
  ) {
    return { type: "transcript", request: request as unknown as AnalyzeRequest };
  }
  return null;
}

function onCapture(event: Event): void {
  if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
  const message = parseCaptureMessage(event.detail);
  if (message === null) return;
  syncView();
  const videoId = message.type === "transcript" ? message.request.videoId : message.videoId;
  const target = view;
  if (target === null || target.videoId !== videoId || target.handled || !target.requested) return;
  if (message.type === "waiting") {
    // Not handled yet: the capture's result replaces this status.
    show(target, analyzing());
    return;
  }
  target.handled = true;

  if (message.type === "no-transcript") show(target, status(TEXT.noTranscript));
  else if (message.type === "capture-failed") show(target, { kind: "status", text: TEXT.captureFailed, options: false, dismiss: true, retry: true });
  else if (message.type === "not-public") show(target, status(TEXT.notPublic));
  else if (message.type === "unsupported") show(target, status(TEXT.unsupported));
  else {
    show(target, analyzing());
    void analyze(target, message.request);
  }
}

document.addEventListener(CAPTURE_EVENT, onCapture);
document.addEventListener(YT.navigateStartEvent, () => {
  removeUi();
  view?.debug?.element.remove();
});
document.addEventListener(YT.navigateFinishEvent, () => {
  syncView();
  render();
});
syncView();
