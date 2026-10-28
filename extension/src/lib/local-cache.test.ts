import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Analysis } from "../../../shared/types.ts";
import { clearCache, evictOld, getCached, MAX_AGE_MS, putCached, type CacheArea } from "./local-cache.ts";

function fakeArea(): CacheArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      if (keys === null) return Object.fromEntries(data);
      return data.has(keys) ? { [keys]: data.get(keys) } : {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys) {
      for (const key of keys) data.delete(key);
    },
  };
}

function analysis(videoId: string): Analysis {
  return {
    videoId,
    title: "T",
    lengthSeconds: 60,
    segments: [],
    payoff: null,
    delivers: 0.9,
    substanceRatio: 0.5,
    model: "mock",
    createdAt: "2026-10-25T00:00:00.000Z",
    cached: false,
  };
}

const NOW = 1_800_000_000_000;

describe("local cache", () => {
  it("returns a saved analysis marked cached", async () => {
    const area = fakeArea();
    await putCached(area, analysis("abcdefghijk"), 2, NOW);
    assert.deepEqual(await getCached(area, "abcdefghijk", 2, NOW + 1000), { ...analysis("abcdefghijk"), cached: true });
  });

  it("misses an unknown video, another version and an entry past its age", async () => {
    const area = fakeArea();
    await putCached(area, analysis("abcdefghijk"), 2, NOW);
    assert.equal(await getCached(area, "zzzzzzzzzzz", 2, NOW), null);
    assert.equal(await getCached(area, "abcdefghijk", 3, NOW), null);
    assert.equal(await getCached(area, "abcdefghijk", 2, NOW + MAX_AGE_MS + 1), null);
  });

  it("evicts only old or unreadable analyses and leaves other keys alone", async () => {
    const area = fakeArea();
    await putCached(area, analysis("oldoldoldol"), 2, NOW - MAX_AGE_MS - 1);
    await putCached(area, analysis("newnewnewne"), 2, NOW - 1000);
    area.data.set("analysis:brokenbroke", "nope");
    area.data.set("openaiApiKey", "sk-test");
    assert.equal(await evictOld(area, NOW), 2);
    assert.deepEqual([...area.data.keys()].sort(), ["analysis:newnewnewne", "openaiApiKey"]);
  });

  it("clears every analysis but keeps the settings", async () => {
    const area = fakeArea();
    await putCached(area, analysis("abcdefghijk"), 2, NOW);
    area.data.set("openaiApiKey", "sk-test");
    assert.equal(await clearCache(area), 1);
    assert.deepEqual([...area.data.keys()], ["openaiApiKey"]);
  });
});
