// Service worker: runs the analysis against OpenAI's Decisions API with the viewer's own key and caches results in
// chrome.storage.local. Nothing goes to any other server. Never log the key or transcripts here.
import { runAnalysis } from "../../pipeline/analysis.ts";
import { ANALYSIS_VERSION, createLiveClient, ModelError } from "../../pipeline/decisions.ts";
import type { AnalysisProgress, AnalyzeRequest } from "../../shared/types.ts";
import { evictOld, getCached, putCached } from "./lib/local-cache.ts";
import {
  ANALYZE_PORT, type AnalysisPortMessage, type AnalyzeResponse, type CachedResponse, type WorkerMessage,
} from "./lib/messages.ts";
import { DEFAULT_SETTINGS, type Settings } from "./lib/settings.ts";

// storage.local is readable from content scripts by default; keep the API key out of YouTube's renderer.
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
// Rotation: analyses older than 60 days go at every worker start.
void evictOld(chrome.storage.local, Date.now()).catch(() => {});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** What the pill says for a failed model call. `reason` is safe: status and error code only, never the message. */
function failure(error: unknown): AnalyzeResponse {
  if (!(error instanceof ModelError)) return { ok: false, reason: "failed", message: "the analysis failed." };
  const { reason } = error;
  if (reason.startsWith("HTTP 401")) return { ok: false, reason: "auth" };
  if (reason.startsWith("HTTP 429")) return { ok: false, reason: "failed", message: "OpenAI quota or rate limit reached." };
  if (reason === "network error" || reason === "timeout") return { ok: false, reason: "network" };
  return { ok: false, reason: "failed", message: `the analysis failed (${reason}).` };
}

async function analyze(request: AnalyzeRequest, report?: (message: AnalysisPortMessage) => void): Promise<AnalyzeResponse> {
  // Read on every request so options saved meanwhile apply to the next video.
  const settings = await chrome.storage.local.get<Settings>(DEFAULT_SETTINGS);
  const debug = settings.debugMode === true && report !== undefined;
  report?.({ type: "debug", enabled: debug });
  if (!settings.openaiApiKey) return { ok: false, reason: "settings" };

  const emit = (event: AnalysisProgress) => {
    if (debug) report?.({ type: "progress", event });
  };
  try {
    // No console log here: debug mode's overlay shows the same calls.
    const analysis = await runAnalysis(createLiveClient(settings.openaiApiKey), request, emit, () => {});
    await putCached(chrome.storage.local, analysis, ANALYSIS_VERSION, Date.now());
    return { ok: true, analysis };
  } catch (error) {
    return failure(error);
  }
}

/** The locally cached analysis for this video, if any, and the auto setting. */
async function cached(videoId: string): Promise<CachedResponse> {
  const settings = await chrome.storage.local.get<Settings>(DEFAULT_SETTINGS);
  const analysis = await getCached(chrome.storage.local, videoId, ANALYSIS_VERSION, Date.now()).catch(() => null);
  return { analysis, autoAnalyze: settings.autoAnalyze === true };
}

function isWorkerMessage(message: unknown): message is WorkerMessage {
  if (!isRecord(message)) return false;
  if (message.type === "analyze") return isRecord(message.request);
  if (message.type === "cached") return typeof message.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(message.videoId);
  return message.type === "open-options";
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: AnalyzeResponse | CachedResponse) => void) => {
    if (!isWorkerMessage(message)) return false;
    if (message.type === "open-options") {
      chrome.runtime.openOptionsPage().catch(() => {});
      return false;
    }
    if (message.type === "cached") {
      cached(message.videoId).then(sendResponse, () => sendResponse({ analysis: null, autoAnalyze: false }));
      return true;
    }
    analyze(message.request).then(sendResponse, () => sendResponse({ ok: false, reason: "network" }));
    return true;
  },
);

// First run: the extension does nothing without a key, so show where it goes.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) chrome.runtime.openOptionsPage().catch(() => {});
});

// The toolbar button has no popup: it opens the options page, where the key goes.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage().catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ANALYZE_PORT) return;
  let open = true;
  let started = false;
  const report = (message: AnalysisPortMessage) => {
    if (!open) return;
    try { port.postMessage(message); } catch { open = false; }
  };
  // A closed tab still lets the analysis finish, so it is cached for next time.
  port.onDisconnect.addListener(() => { open = false; });
  port.onMessage.addListener((message: unknown) => {
    if (started || !isWorkerMessage(message) || message.type !== "analyze") return;
    started = true;
    analyze(message.request, report).then(
      (response) => report({ type: "result", response }),
      () => report({ type: "result", response: { ok: false, reason: "network" } }),
    ).finally(() => { if (open) port.disconnect(); });
  });
});
