// Options page: the provider and its key (and OpenRouter's model), the on-demand/automatic switch, debug mode and
// the local cache.
import { clearCache } from "./lib/local-cache.ts";
import {
  apiKeyToSave, DEFAULT_SETTINGS, normalizeOpenRouterKey, OPENROUTER_MODELS, OPENROUTER_ORIGIN, openRouterModelOf,
  type Provider, providerOf, type Settings, settingsWithKey,
} from "./lib/settings.ts";

const INVALID_KEY: Record<Provider, string> = {
  openai: "Paste an OpenAI API key: it starts with sk-.",
  openrouter: "Paste an OpenRouter key: it starts with sk-or-.",
};
const OPENROUTER_KEY_IN_OPENAI = "That is an OpenRouter key: choose OpenRouter above.";
const NO_PERMISSION = "Unyap needs your permission to reach openrouter.ai. Save again and allow it.";
const SAVED = "Saved. Reload the YouTube tab to apply.";
const REMOVED = "Key removed. Unyap analyzes nothing until you add one.";

const form = document.querySelector<HTMLFormElement>("#unyap-form");
const sections: Record<Provider, HTMLElement | null> = {
  openai: document.querySelector<HTMLElement>("#unyap-openai"),
  openrouter: document.querySelector<HTMLElement>("#unyap-openrouter"),
};
const keys: Record<Provider, HTMLInputElement | null> = {
  openai: document.querySelector<HTMLInputElement>("#unyap-api-key"),
  openrouter: document.querySelector<HTMLInputElement>("#unyap-openrouter-key"),
};
const keyErrors: Record<Provider, HTMLElement | null> = {
  openai: document.querySelector<HTMLElement>("#unyap-api-key-error"),
  openrouter: document.querySelector<HTMLElement>("#unyap-openrouter-key-error"),
};
const model = document.querySelector<HTMLSelectElement>("#unyap-openrouter-model");
const debugMode = document.querySelector<HTMLInputElement>("#unyap-debug-mode");
const autoAnalyze = document.querySelector<HTMLInputElement>("#unyap-auto-analyze");
const saved = document.querySelector<HTMLElement>("#unyap-saved");
const clear = document.querySelector<HTMLButtonElement>("#unyap-clear-cache");
const cleared = document.querySelector<HTMLElement>("#unyap-cleared");

/** The checked provider radio, or OpenAI. */
function chosenProvider(): Provider {
  return document.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value === "openrouter"
    ? "openrouter"
    : "openai";
}

/** Shows only the chosen provider's fields. */
function showProvider(provider: Provider): void {
  for (const name of ["openai", "openrouter"] as const) {
    if (sections[name]) sections[name].hidden = name !== provider;
  }
}

function setError(provider: Provider, message: string): void {
  const input = keys[provider];
  const error = keyErrors[provider];
  if (error) error.textContent = message;
  if (message) {
    input?.setAttribute("aria-invalid", "true");
    input?.focus();
  } else {
    input?.removeAttribute("aria-invalid");
  }
}

if (form && keys.openai && keys.openrouter && model && debugMode && autoAnalyze && saved) {
  const openaiKey = keys.openai;
  const openrouterKey = keys.openrouter;
  for (const option of OPENROUTER_MODELS) model.append(new Option(option.label, option.id));

  // The form stays disabled until the stored settings are on screen, so a fast save cannot overwrite them.
  const controls = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    "input, select, button",
  );
  const setControlsDisabled = (disabled: boolean): void => {
    for (const control of controls) control.disabled = disabled;
  };
  setControlsDisabled(true);

  void chrome.storage.local.get<Settings>(DEFAULT_SETTINGS).then((settings) => {
    const provider = providerOf(settings);
    const radio = document.querySelector<HTMLInputElement>(`input[name="provider"][value="${provider}"]`);
    if (radio) radio.checked = true;
    showProvider(provider);
    openaiKey.value = settings.openaiApiKey;
    openrouterKey.value = settings.openrouterApiKey;
    model.value = openRouterModelOf(settings);
    debugMode.checked = settings.debugMode === true;
    autoAnalyze.checked = settings.autoAnalyze === true;
    setControlsDisabled(false);
  }, () => {
    saved.textContent = "Could not load your settings. Reload the page.";
    setControlsDisabled(false);
  });

  form.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === "provider") showProvider(chosenProvider());
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saved.textContent = "";
    const provider = chosenProvider();
    const other: Provider = provider === "openai" ? "openrouter" : "openai";
    const key = apiKeyToSave(keys[provider]?.value ?? "", provider);
    setError(other, "");
    if (key === null) {
      const typed = keys[provider]?.value ?? "";
      const pastedOpenRouterKey = provider === "openai" && normalizeOpenRouterKey(typed) !== null;
      setError(provider, pastedOpenRouterKey ? OPENROUTER_KEY_IN_OPENAI : INVALID_KEY[provider]);
      return;
    }
    setError(provider, "");
    // Chrome grants the permission only inside the click, so ask before anything awaits.
    const allowed = provider === "openrouter" && key !== ""
      ? chrome.permissions.request({ origins: [OPENROUTER_ORIGIN] })
      : Promise.resolve(true);
    void allowed.catch(() => false).then(async (granted) => {
      if (!granted) {
        setError(provider, NO_PERMISSION);
        return;
      }
      // Read the current keys at save time: the other provider's key is copied from storage, never from the hidden
      // field. Only the active provider's key can be added or removed by this save.
      const current = await chrome.storage.local.get<Settings>(DEFAULT_SETTINGS);
      const settings = settingsWithKey(current, provider, key, model.value, debugMode.checked, autoAnalyze.checked);
      await chrome.storage.local.set(settings);
      openaiKey.value = settings.openaiApiKey;
      openrouterKey.value = settings.openrouterApiKey;
      saved.textContent = key === "" ? REMOVED : SAVED;
    }).catch(() => {
      saved.textContent = "Could not save your settings. Try again.";
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
