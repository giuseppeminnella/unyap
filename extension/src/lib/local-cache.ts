// Analyses cached in the browser (chrome.storage.local), one per video, dropped after MAX_AGE_MS.
import type { Analysis } from "../../../shared/types.ts";

export const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const PREFIX = "analysis:";

/** The part of chrome.storage.StorageArea the cache uses (tests pass a Map-backed fake). */
export interface CacheArea {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

interface Entry {
  analysis: Analysis;
  savedAt: number;
  /** ANALYSIS_VERSION at save time: a prompt change makes older entries misses. */
  version: number;
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.savedAt === "number" && typeof entry.version === "number" &&
    typeof entry.analysis === "object" && entry.analysis !== null;
}

/** The cached analysis for this video, or null when there is none, it is too old or from another version. */
export async function getCached(area: CacheArea, videoId: string, version: number, now: number): Promise<Analysis | null> {
  const key = PREFIX + videoId;
  const entry = (await area.get(key))[key];
  if (!isEntry(entry) || entry.version !== version || now - entry.savedAt > MAX_AGE_MS) return null;
  return { ...entry.analysis, cached: true };
}

export async function putCached(area: CacheArea, analysis: Analysis, version: number, now: number): Promise<void> {
  const entry: Entry = { analysis, savedAt: now, version };
  await area.set({ [PREFIX + analysis.videoId]: entry });
}

/** Removes entries older than MAX_AGE_MS or unreadable; returns how many were removed. */
export async function evictOld(area: CacheArea, now: number): Promise<number> {
  const all = await area.get(null);
  const stale = Object.entries(all)
    .filter(([key, value]) => key.startsWith(PREFIX) && (!isEntry(value) || now - value.savedAt > MAX_AGE_MS))
    .map(([key]) => key);
  if (stale.length > 0) await area.remove(stale);
  return stale.length;
}

/** Removes every cached analysis (the options page's "Clear cache"); returns how many were removed. */
export async function clearCache(area: CacheArea): Promise<number> {
  const keys = Object.keys(await area.get(null)).filter((key) => key.startsWith(PREFIX));
  if (keys.length > 0) await area.remove(keys);
  return keys.length;
}
