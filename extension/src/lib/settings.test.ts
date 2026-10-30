import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apiKeyToSave, DEFAULT_SETTINGS, normalizeApiKey, normalizeOpenRouterKey, OPENROUTER_MODELS, openRouterModelOf,
  providerOf, settingsWithKey, type Settings,
} from "./settings.ts";

const OPENROUTER_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

describe("DEFAULT_SETTINGS", () => {
  it("starts on OpenAI without a key, in on-demand mode, with Luna as the OpenRouter model", () => {
    assert.deepEqual(DEFAULT_SETTINGS, {
      provider: "openai",
      openaiApiKey: "",
      openrouterApiKey: "",
      openrouterModel: "openai/gpt-6-luna-decisions",
      debugMode: false,
      autoAnalyze: false,
    });
  });

  it("offers only pinned OpenRouter models, never an alias", () => {
    assert.ok(OPENROUTER_MODELS.length > 0);
    for (const model of OPENROUTER_MODELS) assert.match(model.id, /^[a-z0-9-]+\/[a-z0-9.-]+$/);
  });
});

describe("normalizeApiKey", () => {
  it("accepts project and legacy keys, trimmed", () => {
    assert.equal(normalizeApiKey("  sk-proj-abcdefghijklmnopqrstuvwxyz0123 "), "sk-proj-abcdefghijklmnopqrstuvwxyz0123");
    assert.equal(normalizeApiKey("sk-abcdefghijklmnopqrstuvwxyz"), "sk-abcdefghijklmnopqrstuvwxyz");
  });

  for (const input of ["", "sk-short", "pk-abcdefghijklmnopqrstuvwxyz", "sk-abc def ghi jkl mno pqr stu", "hello"]) {
    it(`rejects ${JSON.stringify(input)}`, () => assert.equal(normalizeApiKey(input), null));
  }

  it("rejects an OpenRouter key, which belongs in the other field", () => {
    assert.equal(normalizeApiKey(OPENROUTER_KEY), null);
  });
});

describe("normalizeOpenRouterKey", () => {
  it("accepts an OpenRouter key, trimmed, and nothing else", () => {
    assert.equal(normalizeOpenRouterKey(` ${OPENROUTER_KEY} `), OPENROUTER_KEY);
    assert.equal(normalizeOpenRouterKey("sk-proj-abcdefghijklmnopqrstuvwxyz0123"), null);
    assert.equal(normalizeOpenRouterKey("sk-or-short"), null);
  });
});

describe("providerOf and openRouterModelOf", () => {
  it("fall back to OpenAI and the default model for settings saved before providers existed", () => {
    assert.equal(providerOf({ openaiApiKey: "sk-abcdefghijklmnopqrstuvwxyz" }), "openai");
    assert.equal(providerOf({ provider: "openrouter" }), "openrouter");
    assert.equal(openRouterModelOf({}), "openai/gpt-6-luna-decisions");
    assert.equal(openRouterModelOf({ openrouterModel: "~typesafe/jev-latest" }), "openai/gpt-6-luna-decisions");
    assert.equal(openRouterModelOf({ openrouterModel: "typesafe/jev-1.14" }), "typesafe/jev-1.14");
  });
});

describe("apiKeyToSave", () => {
  it("saves an empty field as no key, so the viewer can remove theirs", () => {
    assert.equal(apiKeyToSave(""), "");
    assert.equal(apiKeyToSave("   "), "");
  });

  it("saves a valid key trimmed and refuses anything else", () => {
    assert.equal(apiKeyToSave(" sk-abcdefghijklmnopqrstuvwxyz "), "sk-abcdefghijklmnopqrstuvwxyz");
    assert.equal(apiKeyToSave("not a key"), null);
    assert.equal(apiKeyToSave(OPENROUTER_KEY, "openrouter"), OPENROUTER_KEY);
    assert.equal(apiKeyToSave(OPENROUTER_KEY, "openai"), null);
    assert.equal(apiKeyToSave("  ", "openrouter"), "");
  });
});

describe("settingsWithKey", () => {
  const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz";
  const stored: Settings = {
    ...DEFAULT_SETTINGS,
    openaiApiKey: OPENAI_KEY,
    openrouterApiKey: OPENROUTER_KEY,
  };

  it("saves the active key and keeps the other provider's key", () => {
    const settings = settingsWithKey(stored, "openrouter", "sk-or-v1-new-key-0123456789abcdef", "typesafe/jev-1.14", true, true);
    assert.deepEqual(settings, {
      provider: "openrouter",
      openaiApiKey: OPENAI_KEY,
      openrouterApiKey: "sk-or-v1-new-key-0123456789abcdef",
      openrouterModel: "typesafe/jev-1.14",
      debugMode: true,
      autoAnalyze: true,
    });
  });

  it("keeps the OpenRouter key when saving OpenAI", () => {
    const settings = settingsWithKey(stored, "openai", OPENAI_KEY, "typesafe/jev-1.14", false, false);
    assert.equal(settings.openaiApiKey, OPENAI_KEY);
    assert.equal(settings.openrouterApiKey, OPENROUTER_KEY);
  });

  it("removes only the active provider's key when its field is empty", () => {
    const openaiRemoved = settingsWithKey(stored, "openai", "", "", false, false);
    assert.equal(openaiRemoved.openaiApiKey, "");
    assert.equal(openaiRemoved.openrouterApiKey, OPENROUTER_KEY);

    const openrouterRemoved = settingsWithKey(stored, "openrouter", "", "", false, false);
    assert.equal(openrouterRemoved.openaiApiKey, OPENAI_KEY);
    assert.equal(openrouterRemoved.openrouterApiKey, "");
  });

  it("falls back to the default model for an unknown model", () => {
    const settings = settingsWithKey(stored, "openai", OPENAI_KEY, "~typesafe/jev-latest", false, false);
    assert.equal(settings.openrouterModel, "openai/gpt-6-luna-decisions");
  });
});
