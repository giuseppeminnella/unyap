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
import { MAX_CAPTURE_JSON_CHARS, parseAnalyzeRequest } from "../../shared/validate.ts";
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
  type SetModelResponse,
  type WorkerMessage,
} from "./lib/messages.ts";
import { OPENROUTER_MODELS, type Provider } from "./lib/settings.ts";

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
  settings: (provider: string) => `Unyap: add your ${provider} API key in the options.`,
  auth: (provider: string) => `Unyap: ${provider} rejected your API key.`,
  network: (provider: string) => `Unyap: can't reach ${provider}.`,
  permission: "Unyap: allow openrouter.ai in the options (save them again).",
  stopped: "Unyap: the analysis stopped. Try again.",
  noTranscript: "Unyap: this video has no transcript.",
  captureFailed: "Unyap: couldn't read the transcript.",
  notPublic: "Unyap: skipped (private or unlisted video).",
  unsupported: "Unyap: live streams and premieres aren't supported.",
  offer: "Unyap this video",
  gear: "Choose the OpenRouter model",
  retry: "Retry the analysis",
  previous: "Previous",
  next: "Next good part",
};

type Display =
  | { kind: "analysis"; analysis: Analysis }
  | { kind: "status"; text: string; options: boolean; dismiss: boolean; error?: boolean }
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
  /** Bumped on every retry so a finish from an older port cannot revive or close the new analysis. */
  generation: number;
  /** From the worker's cached answer: the active provider and the OpenRouter model shown in the gear menu. */
  provider: Provider | null;
  openrouterModel: string | null;
}

let view: View | null = null;
let resizeObserver: ResizeObserver | null = null;
// Removes the pill's listeners on the video along with the pill.
let pillListeners: AbortController | null = null;

function status(text: string, options = false, error = false): Display {
  return { kind: "status", text, options, dismiss: true, error };
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
  // Page scripts share this DOM and can call click(): only a real viewer click may spend the viewer's API key.
  node.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    onClick(event);
  });
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
    : {
      videoId,
      handled: false,
      requested: false,
      display: null,
      debug: null,
      port: null,
      generation: 0,
      provider: null,
      openrouterModel: null,
    };
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
  if (response) {
    target.provider = response.provider;
    target.openrouterModel = response.openrouterModel;
  }
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
  target.generation += 1;
  if (target.port) {
    try { target.port.disconnect(); } catch { /* already closed */ }
    target.port = null;
  }
  if (target.debug) {
    target.debug.element.remove();
    target.debug = null;
  }
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

// Material Design paths, drawn with the pill's currentColor.
const GEAR_PATH =
  "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 " +
  "0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-" +
  ".36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05." +
  "3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03." +
  "7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c." +
  "22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58ZM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 " +
  "7.2Z";
const REFRESH_PATH =
  "M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10.07h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4" +
  "l-2.35 2.35Z";
const ERROR_PATH =
  "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z";

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function iconButton(
  label: string,
  path: string,
  className: string,
  onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
  const node = button("", className, onClick);
  node.setAttribute("aria-label", label);
  node.title = label;
  node.append(icon(path));
  return node;
}

/** The gear and its model menu, above the pill. Only an OpenRouter key has models to choose from. */
function modelMenu(target: View): { gear: HTMLButtonElement; menu: HTMLElement } {
  const menu = element("div", "unyap-model-menu");
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "OpenRouter model");
  const gear = iconButton(TEXT.gear, GEAR_PATH, "unyap-tool", () => {
    menu.hidden = !menu.hidden;
    gear.setAttribute("aria-expanded", String(!menu.hidden));
  });
  gear.setAttribute("aria-haspopup", "menu");
  gear.setAttribute("aria-expanded", "false");
  for (const model of OPENROUTER_MODELS) {
    const option = button(model.label, "unyap-model-option", () => {
      void chooseModel(target, model.id, gear, menu);
    });
    option.dataset.model = model.id;
    option.setAttribute("role", "menuitemradio");
    option.setAttribute("aria-checked", String(model.id === target.openrouterModel));
    menu.append(option);
  }
  return { gear, menu };
}

async function chooseModel(
  target: View,
  model: string,
  gear: HTMLButtonElement,
  menu: HTMLElement,
): Promise<void> {
  try {
    const response = (await sendToWorker({ type: "set-model", model })) as SetModelResponse | null;
    if (!response?.ok) return;
    target.openrouterModel = response.model;
    for (const option of menu.querySelectorAll<HTMLElement>(".unyap-model-option")) {
      option.setAttribute("aria-checked", String(option.dataset.model === response.model));
    }
    menu.hidden = true;
    gear.setAttribute("aria-expanded", "false");
  } catch {
    // Keep the picker open: the next retry reports whether the provider is reachable.
  }
}

function buildTools(target: View, retry: (event: MouseEvent) => void): HTMLElement[] {
  const tools: HTMLElement[] = [];
  if (target.provider === "openrouter") {
    const { gear, menu } = modelMenu(target);
    tools.push(gear, menu);
  }
  tools.push(iconButton(TEXT.retry, REFRESH_PATH, "unyap-tool", retry));
  return tools;
}

function buildPill(target: View, display: Display, signal: AbortSignal): HTMLElement {
  const pill = element("div", "unyap-pill");
  for (const type of CONTAINED_EVENTS) pill.addEventListener(type, (event) => event.stopPropagation());

  // After a pointer click, focus goes back to the player so YouTube's keys keep working.
  const retry = (event: MouseEvent): void => {
    startCapture(target);
    if (event.detail > 0) document.querySelector<HTMLElement>(YT.player)?.focus({ preventScroll: true });
  };
  const tools = buildTools(target, retry);

  if (display.kind === "offer") {
    pill.append(...tools, button(TEXT.offer, "unyap-jump", retry));
    return pill;
  }

  if (display.kind === "status") {
    const note = element("div", "unyap-note");
    note.setAttribute("role", display.error ? "alert" : "status");
    if (display.error) {
      const badge = element("span", "unyap-note-icon");
      badge.setAttribute("aria-hidden", "true");
      badge.append(icon(ERROR_PATH));
      note.append(badge);
    }
    note.append(element("span", "unyap-note-text", display.text));
    note.title = display.text;
    if (display.options) {
      note.append(
        button("Options", "unyap-note-button", () => {
          sendToWorker({ type: "open-options" }).catch(() => {});
        }),
      );
    }
    if (display.dismiss) {
      const dismiss = button("×", "unyap-note-dismiss", () => show(target, null));
      dismiss.setAttribute("aria-label", "Dismiss");
      note.append(dismiss);
    }
    // "Analyzing" has no action of its own; the refresh icon above it is the retry.
    if (display.text === TEXT.analyzing) {
      pill.append(...tools, note);
    } else {
      pill.append(...tools, button(TEXT.offer, "unyap-jump", retry), note);
    }
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
    pill.append(...tools, note);
  } else {
    const label = result === "uncertain" ? "Unyap it?" : "Unyap it";
    jump = button(`${label} · ${formatTime(payoff.startMs)}`, "unyap-jump", () => seekFromPill(payoff.startMs));
    if (result === "uncertain") jump.title = "Not sure this is the point";
    pill.append(...tools, jump);
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
  if (response === undefined) return status(TEXT.stopped, false, true);
  if (response.ok) return { kind: "analysis", analysis: response.analysis };
  switch (response.reason) {
    case "settings":
      return status(TEXT.settings(response.provider), true, true);
    case "auth":
      return status(TEXT.auth(response.provider), true, true);
    case "network":
      return status(TEXT.network(response.provider), false, true);
    case "permission":
      return status(TEXT.permission, true, true);
    case "failed":
      return status(`Unyap: ${response.message}`, false, true);
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
  const generation = target.generation;
  let finished = false;
  const finish = (response: AnalyzeResponse | undefined) => {
    if (finished || target.generation !== generation) return;
    finished = true;
    if (target.port === port) target.port = null;
    if (view === target) {
      const display = responseDisplay(response);
      target.debug?.finish(response?.ok ? response.analysis : null, display.kind === "status" ? display.text : undefined);
      show(target, display);
    }
    try { port.disconnect(); } catch { /* already closed */ }
  };
  port.onMessage.addListener((message: AnalysisPortMessage) => {
    if (view !== target || finished || target.generation !== generation) return;
    if (message.type === "debug" && message.enabled) {
      const overlay = new DebugOverlay(() => {
        if (target.debug === overlay) target.debug = null;
      });
      target.debug = overlay;
      for (const type of CONTAINED_EVENTS) {
        overlay.element.addEventListener(type, (event) => event.stopPropagation());
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
  if (message.type === "transcript") {
    const request = parseAnalyzeRequest(message.request);
    return request === null ? null : { type: "transcript", request };
  }
  return null;
}

function onCapture(event: Event): void {
  if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
  // Refuse to parse a page-sized message; a real transcript is far below this.
  if (event.detail.length > MAX_CAPTURE_JSON_CHARS) return;
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
  else if (message.type === "capture-failed") show(target, status(TEXT.captureFailed, false, true));
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
