import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, expect, test, type BrowserContext, type Worker } from "@playwright/test";
import { buildDecisionsRequest, buildRefinementRequest, createMockClient } from "../pipeline/decisions.ts";
import { mapResponse } from "../pipeline/analysis.ts";
import { refinementLines, segmentTranscript } from "../pipeline/segments.ts";
import { CAPTURE_EVENT, type AnalyzeResponse, type CachedResponse } from "../extension/src/lib/messages.ts";
import type { AnalyzeRequest } from "../shared/types.ts";
import { e2eEggVideo } from "./fixtures.ts";

const KEY = "sk-test-e2eKey0123456789abcdef";

/** The Decisions API's answers for `request`, from the pipeline's deterministic mock client. */
async function mockAnswers(request: AnalyzeRequest): Promise<{ main: unknown; refine: unknown }> {
  const client = createMockClient();
  const segments = segmentTranscript(request);
  const main = await client.decide(buildDecisionsRequest(request, segments), segments);
  const { analysis } = mapResponse(main, request, segments);
  const lines = refinementLines(request, analysis.payoff?.segmentIndex ?? 0);
  const refine = await client.refine(buildRefinementRequest(request, lines), lines);
  return { main, refine };
}

/** Replaces the worker's fetch with a fake api.openai.com; anything else throws. `hold` delays the main answer. */
async function fakeOpenAi(worker: Worker, answers: { main: unknown; refine: unknown }, hold = false): Promise<void> {
  await worker.evaluate(({ answers, key, hold }) => {
    const scope = globalThis as typeof globalThis & { release?: () => void; calls?: number };
    scope.calls = 0;
    let released: Promise<void> = Promise.resolve();
    if (hold) released = new Promise((resolve) => { scope.release = () => resolve(); });
    globalThis.fetch = async (input, init) => {
      if (input !== "https://api.openai.com/v1/decisions") throw new Error(`Unexpected URL ${String(input)}`);
      if (new Headers(init?.headers).get("Authorization") !== `Bearer ${key}`) throw new Error("Wrong key");
      scope.calls = (scope.calls ?? 0) + 1;
      const body = JSON.parse(String(init?.body)) as { questions: { name: string }[] };
      const refine = body.questions.some((question) => question.name === "start");
      if (!refine) await released;
      return new Response(JSON.stringify(refine ? answers.refine : answers.main), {
        headers: { "Content-Type": "application/json" },
      });
    };
  }, { answers, key: KEY, hold });
}

async function launch(outputPath: string): Promise<{ context: BrowserContext; worker: Worker }> {
  const extension = join(import.meta.dirname, "..", "extension", "dist");
  const context = await chromium.launchPersistentContext(outputPath, {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  return { context, worker };
}

/** Serves every youtube.com URL as a fake watch page whose player answers getPlayerResponse with `response` (JS). */
async function routeWatchPage(context: BrowserContext, response: string): Promise<void> {
  await context.route("https://www.youtube.com/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><style>
      body { margin: 40px; background: #edf0f2; }
      #movie_player { position: relative; width: 960px; height: 540px; background: #172029; }
      video { width: 100%; height: 100%; }
      .ytp-chrome-bottom { position: absolute; bottom: 0; left: 12px; right: 12px; height: 42px; }
      .ytp-progress-bar-container { position: relative; height: 6px; background: #777; }
    </style></head><body><div id="movie_player" tabindex="0"><video></video>
      <div class="ytp-chrome-bottom"><div class="ytp-progress-bar-container"></div></div>
    </div><script>
      document.querySelector("#movie_player").getPlayerResponse = () => ${response};
    </script></body></html>`,
  }));
}

test("the extension analyzes with the viewer's own key and caches locally", async ({}, info) => {
  const { context, worker } = await launch(info.outputPath("profile"));
  try {
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest).toMatchObject({
      name: "Unyap", version: "1.0.0", homepage_url: "https://giuseppe.dev/unyap/", action: { default_title: "Unyap" },
    });
    for (const icon of Object.values(manifest.icons ?? {})) {
      expect(await worker.evaluate(async (path) => (await fetch(chrome.runtime.getURL(path))).headers.get("content-type"),
        icon)).toBe("image/png");
    }
    expect(Object.keys(manifest.icons ?? {})).toEqual(["16", "32", "48", "128"]);
    expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ["https://api.openai.com/*"] }))).toBe(true);
    expect(await worker.evaluate(() => chrome.permissions.contains({ permissions: ["unlimitedStorage"] }))).toBe(true);

    const optionsUrl = `chrome-extension://${new URL(worker.url()).host}/options.html`;
    await expect.poll(() => context.pages().map((open) => open.url()), { message: "options open on install" })
      .toContain(optionsUrl);
    const page = await context.newPage();
    await page.goto(optionsUrl);
    await expect(page).toHaveTitle("Unyap options");
    await expect(page.getByRole("link", { name: "Get a key" })).toHaveAttribute("href", "https://platform.openai.com/api-keys");
    await expect(page.getByText("at your own responsibility and cost")).toBeVisible();
    await expect(page.getByText("Nothing is sent to me, its developer, and I store no data.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Terms of use" })).toHaveAttribute("href", "https://giuseppe.dev/unyap/terms/");
    await expect(page.getByRole("link", { name: "Privacy policy" })).toHaveAttribute("href", "https://giuseppe.dev/unyap/privacy/");
    const key = page.getByLabel("OpenAI API key");
    await key.fill("not a key");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Paste an OpenAI API key: it starts with sk-.")).toBeVisible();
    await key.fill(` ${KEY} `);
    await page.getByRole("checkbox", { name: "Debug mode" }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#unyap-saved")).toHaveText("Saved. Reload the YouTube tab to apply.");
    expect(await worker.evaluate(() => chrome.storage.local.get(["openaiApiKey", "debugMode", "autoAnalyze"]))).toEqual({
      openaiApiKey: KEY, debugMode: true, autoAnalyze: false,
    });

    await fakeOpenAi(worker, await mockAnswers(e2eEggVideo));
    const response: AnalyzeResponse = await page.evaluate((request) =>
      chrome.runtime.sendMessage({ type: "analyze", request }), e2eEggVideo);
    expect(response).toMatchObject({ ok: true, analysis: { videoId: e2eEggVideo.videoId, cached: false } });
    expect(await worker.evaluate(() => (globalThis as typeof globalThis & { calls?: number }).calls)).toBe(2);

    const hit: CachedResponse = await page.evaluate((videoId) =>
      chrome.runtime.sendMessage({ type: "cached", videoId }), e2eEggVideo.videoId);
    expect(hit).toMatchObject({ autoAnalyze: false, analysis: { videoId: e2eEggVideo.videoId, cached: true } });

    await page.getByRole("button", { name: "Clear cache" }).click();
    await expect(page.locator("#unyap-cleared")).toHaveText("Removed 1 cached analysis.");
    const miss: CachedResponse = await page.evaluate((videoId) =>
      chrome.runtime.sendMessage({ type: "cached", videoId }), e2eEggVideo.videoId);
    expect(miss.analysis).toBeNull();
    expect(await worker.evaluate(() => chrome.storage.local.get("openaiApiKey"))).toEqual({ openaiApiKey: KEY });

    // Emptying the field and saving removes the key.
    await key.fill("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#unyap-saved")).toHaveText("Key removed. Unyap analyzes nothing until you add one.");
    expect(await worker.evaluate(() => chrome.storage.local.get("openaiApiKey"))).toEqual({ openaiApiKey: "" });
  } finally {
    await context.close();
  }
});

test("on a watch page: Unyap this video, debug overlay, then the cached result", async ({}, info) => {
  const { context, worker } = await launch(info.outputPath("profile"));
  try {
    await worker.evaluate((key) => chrome.storage.local.set({ openaiApiKey: key, debugMode: true }), KEY);
    const request = { ...e2eEggVideo, videoId: randomBytes(8).toString("base64url") };
    await fakeOpenAi(worker, await mockAnswers(request), true);

    // This player never reports the video as loaded, so page.ts keeps waiting and the test hands over the transcript.
    await routeWatchPage(context, `({ videoDetails: { videoId: "not-this-one" } })`);
    const page = await context.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${request.videoId}`);

    // A transcript nobody asked for is ignored: no analysis, the offer stays.
    const dispatchTranscript = () => page.evaluate(({ request, name }) => {
      document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify({ type: "transcript", request }) }));
    }, { request, name: CAPTURE_EVENT });
    await expect(page.getByRole("button", { name: "Unyap this video" })).toBeVisible();
    await dispatchTranscript();
    await expect(page.getByRole("button", { name: "Unyap this video" })).toBeVisible();
    expect(await worker.evaluate(() => (globalThis as typeof globalThis & { calls?: number }).calls ?? 0)).toBe(0);

    // Nothing is captured until the viewer asks; the fixture player has no captions, so the test hands over the transcript.
    await page.getByRole("button", { name: "Unyap this video" }).click();
    await expect(page.locator(".unyap-note-text")).toHaveText("Unyap: analyzing…");
    await dispatchTranscript();

    const panel = page.getByRole("region", { name: "Unyap debug mode" });
    await expect(panel).toBeVisible();
    await expect(panel.locator(".unyap-debug-status")).toHaveText("SCORING");
    await expect(panel).not.toContainText(KEY);
    await worker.evaluate(() => (globalThis as typeof globalThis & { release?: () => void }).release?.());
    await expect(page.getByRole("button", { name: /^Unyap it/ })).toBeVisible();
    await expect(panel.locator(".unyap-debug-status")).toHaveText("READY");
    await expect(panel).not.toContainText(request.transcript[0]!.text);

    // The second visit answers from the local cache: no button, no capture, no OpenAI call.
    await page.goto(`https://www.youtube.com/watch?v=${request.videoId}`);
    await expect(page.getByRole("button", { name: /^Unyap it/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unyap this video" })).toHaveCount(0);
    expect(await worker.evaluate(() => (globalThis as typeof globalThis & { calls?: number }).calls)).toBe(2);
  } finally {
    await context.close();
  }
});

test("a live stream or premiere says it is not supported instead of analyzing forever", async ({}, info) => {
  const { context, worker } = await launch(info.outputPath("profile"));
  try {
    await worker.evaluate((key) => chrome.storage.local.set({ openaiApiKey: key }), KEY);
    await routeWatchPage(context, `({ videoDetails: { videoId: new URL(location.href).searchParams.get("v"), lengthSeconds: "0" } })`);
    const page = await context.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${randomBytes(8).toString("base64url")}`);

    await page.getByRole("button", { name: "Unyap this video" }).click();
    await expect(page.locator(".unyap-note-text")).toHaveText("Unyap: live streams and premieres aren't supported.");
  } finally {
    await context.close();
  }
});

test("an analysis that could not be cached is still shown", async ({}, info) => {
  const { context, worker } = await launch(info.outputPath("profile"));
  try {
    await worker.evaluate((key) => chrome.storage.local.set({ openaiApiKey: key }), KEY);
    await fakeOpenAi(worker, await mockAnswers(e2eEggVideo));
    // Every cache write fails, as on a full or broken profile.
    await worker.evaluate(() => {
      const area = chrome.storage.local;
      const set = area.set.bind(area);
      area.set = ((items: Record<string, unknown>) => Object.keys(items).some((key) => key.startsWith("analysis:"))
        ? Promise.reject(new Error("storage write failed"))
        : set(items)) as typeof area.set;
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);

    const response: AnalyzeResponse = await page.evaluate((request) =>
      chrome.runtime.sendMessage({ type: "analyze", request }), e2eEggVideo);
    expect(response).toMatchObject({ ok: true, analysis: { videoId: e2eEggVideo.videoId } });
    const miss: CachedResponse = await page.evaluate((videoId) =>
      chrome.runtime.sendMessage({ type: "cached", videoId }), e2eEggVideo.videoId);
    expect(miss.analysis).toBeNull();
  } finally {
    await context.close();
  }
});
