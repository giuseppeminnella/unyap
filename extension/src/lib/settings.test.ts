import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiKeyToSave, DEFAULT_SETTINGS, normalizeApiKey } from "./settings.ts";

describe("DEFAULT_SETTINGS", () => {
  it("starts without a key, in on-demand mode", () => {
    assert.deepEqual(DEFAULT_SETTINGS, { openaiApiKey: "", debugMode: false, autoAnalyze: false });
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
});

describe("apiKeyToSave", () => {
  it("saves an empty field as no key, so the viewer can remove theirs", () => {
    assert.equal(apiKeyToSave(""), "");
    assert.equal(apiKeyToSave("   "), "");
  });

  it("saves a valid key trimmed and refuses anything else", () => {
    assert.equal(apiKeyToSave(" sk-abcdefghijklmnopqrstuvwxyz "), "sk-abcdefghijklmnopqrstuvwxyz");
    assert.equal(apiKeyToSave("not a key"), null);
  });
});
