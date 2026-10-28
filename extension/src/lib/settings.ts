// The extension's settings. Stored in chrome.storage.local by the options page; only trusted contexts read them.

export interface Settings {
  /** The viewer's own OpenAI API key; it never leaves the browser except in requests to api.openai.com. */
  openaiApiKey: string;
  debugMode: boolean;
  /** Capture and analyze every new video on its own; off means only when the viewer clicks "Unyap this video". */
  autoAnalyze: boolean;
}

export const DEFAULT_SETTINGS: Settings = { openaiApiKey: "", debugMode: false, autoAnalyze: false };

/** A pasted key without surrounding whitespace, or null when it doesn't look like an OpenAI key. */
export function normalizeApiKey(input: string): string | null {
  const key = input.trim();
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key) ? key : null;
}

/** What Save stores from the key field: "" for an empty field (removes the key), null when it isn't a key. */
export function apiKeyToSave(input: string): string | null {
  return input.trim() === "" ? "" : normalizeApiKey(input);
}
