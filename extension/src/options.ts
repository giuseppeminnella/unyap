// Options page: the viewer's OpenAI API key, the on-demand/automatic switch, debug mode and the local cache.
import { clearCache } from "./lib/local-cache.ts";
import { DEFAULT_SETTINGS, normalizeApiKey, type Settings } from "./lib/settings.ts";

const INVALID_KEY = "Paste an OpenAI API key: it starts with sk-.";
const SAVED = "Saved. Reload the YouTube tab to apply.";

const form = document.querySelector<HTMLFormElement>("#unyap-form");
const apiKey = document.querySelector<HTMLInputElement>("#unyap-api-key");
const debugMode = document.querySelector<HTMLInputElement>("#unyap-debug-mode");
const autoAnalyze = document.querySelector<HTMLInputElement>("#unyap-auto-analyze");
const keyError = document.querySelector<HTMLElement>("#unyap-api-key-error");
const saved = document.querySelector<HTMLElement>("#unyap-saved");
const clear = document.querySelector<HTMLButtonElement>("#unyap-clear-cache");
const cleared = document.querySelector<HTMLElement>("#unyap-cleared");

if (form && apiKey && debugMode && autoAnalyze && keyError && saved) {
  void chrome.storage.local.get<Settings>(DEFAULT_SETTINGS).then((settings) => {
    apiKey.value = settings.openaiApiKey;
    debugMode.checked = settings.debugMode === true;
    autoAnalyze.checked = settings.autoAnalyze === true;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saved.textContent = "";
    const key = normalizeApiKey(apiKey.value);
    if (key === null) {
      keyError.textContent = INVALID_KEY;
      apiKey.setAttribute("aria-invalid", "true");
      apiKey.focus();
      return;
    }
    keyError.textContent = "";
    apiKey.removeAttribute("aria-invalid");
    const settings: Settings = { openaiApiKey: key, debugMode: debugMode.checked, autoAnalyze: autoAnalyze.checked };
    void chrome.storage.local.set(settings).then(() => {
      apiKey.value = key;
      saved.textContent = SAVED;
    });
  });
}

if (clear && cleared) {
  clear.addEventListener("click", () => {
    void clearCache(chrome.storage.local).then((count) => {
      cleared.textContent = `Removed ${count} cached ${count === 1 ? "analysis" : "analyses"}.`;
    });
  });
}
