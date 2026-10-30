// The extension's settings. Stored in chrome.storage.local by the options page; only trusted contexts read them.

/** Where the analysis runs: OpenAI's Decisions API directly, or a decision model through OpenRouter. */
export type Provider = "openai" | "openrouter";

export const PROVIDER_NAMES: Record<Provider, string> = { openai: "OpenAI", openrouter: "OpenRouter" };

/** The origin the extension asks for, at runtime, only when the viewer chooses OpenRouter. */
export const OPENROUTER_ORIGIN = "https://openrouter.ai/*";

/** The model Unyap is tuned on, also served through OpenRouter. */
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-6-luna-decisions";

/**
 * The decision models the options offer: pinned ids (never a `~` alias, which can change under us), each with enough
 * context for a long video's transcript. The first is the default.
 */
export const OPENROUTER_MODELS: readonly { id: string; label: string }[] = [
  { id: DEFAULT_OPENROUTER_MODEL, label: "OpenAI GPT-6 Luna (the model Unyap is tuned on)" },
  { id: "typesafe/jev-1.14", label: "TypeSafe Jev 1.14" },
  { id: "perplexity/pplx-decider-v1.2", label: "Perplexity Decider v1.2" },
  { id: "upstage/solar-decide", label: "Upstage Solar Decide" },
];

export interface Settings {
  provider: Provider;
  /** The viewer's own OpenAI API key; it never leaves the browser except in requests to api.openai.com. */
  openaiApiKey: string;
  /** The viewer's own OpenRouter key; it never leaves the browser except in requests to openrouter.ai. */
  openrouterApiKey: string;
  /** One of OPENROUTER_MODELS. */
  openrouterModel: string;
  debugMode: boolean;
  /** Capture and analyze every new video on its own; off means only when the viewer clicks "Unyap this video". */
  autoAnalyze: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "openai",
  openaiApiKey: "",
  openrouterApiKey: "",
  openrouterModel: DEFAULT_OPENROUTER_MODEL,
  debugMode: false,
  autoAnalyze: false,
};

/** A pasted OpenAI key without surrounding whitespace, or null when it doesn't look like one. */
export function normalizeApiKey(input: string): string | null {
  const key = input.trim();
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key) && !isOpenRouterKey(key) ? key : null;
}

function isOpenRouterKey(key: string): boolean {
  return /^sk-or-[A-Za-z0-9_-]{20,}$/.test(key);
}

/** A pasted OpenRouter key without surrounding whitespace, or null when it doesn't look like one. */
export function normalizeOpenRouterKey(input: string): string | null {
  const key = input.trim();
  return isOpenRouterKey(key) ? key : null;
}

/** What Save stores from a key field: "" for an empty field (removes the key), null when it isn't a key. */
export function apiKeyToSave(input: string, provider: Provider = "openai"): string | null {
  if (input.trim() === "") return "";
  return provider === "openai" ? normalizeApiKey(input) : normalizeOpenRouterKey(input);
}

/** The stored provider, or OpenAI for anything else (settings saved before providers existed). */
export function providerOf(settings: Partial<Settings>): Provider {
  return settings.provider === "openrouter" ? "openrouter" : "openai";
}

/** The stored model when it is one the options offer, else the default. */
export function openRouterModelOf(settings: Partial<Settings>): string {
  return OPENROUTER_MODELS.find((model) => model.id === settings.openrouterModel)?.id ?? DEFAULT_OPENROUTER_MODEL;
}
