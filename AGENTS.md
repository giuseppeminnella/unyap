# AGENTS.md — Unyap

Unyap ("Impatience, now a browser extension.") jumps you straight to the part of a YouTube video that delivers what
its title promised. A Chrome extension reads the video's transcript, asks a Decisions API (OpenAI's, or a decision
model through OpenRouter, with the viewer's own key) where the payoff is and how much of each part is filler, and
draws a substance strip over the progress bar plus an "Unyap it" button. Everything runs in the viewer's browser;
there is no server.

Built for the DevDay Community Hackathon, Berlin, 24 Oct 2026. The extension's home page, privacy policy and terms
are on Giuseppe's blog: `https://giuseppe.dev/unyap/`, `/unyap/privacy/` and `/unyap/terms/` (`src/unyap/` in the
public repo giuseppeminnella/giuseppe.dev; privacy and terms are `noindex`).

## Layout

```
pipeline/      the analysis pipeline the extension bundles (analysis, decisions, segments, guards) and its tests
shared/        types.ts (shared types), validate.ts (AnalyzeRequest bounds), timeline.ts (pure UI helpers), *.test.ts
extension/     Chrome MV3 extension: src/*.ts entries (bundled to dist/*.js), src/lib/ helpers and their tests
               (not entries), static/ (manifest, options page, stylesheet, icons), icon.svg (icon source)
scripts/       build.ts (esbuild bundles), icons.ts (PNG icons from icon.svg), package.ts + zip.ts (store zip)
e2e/           Playwright test that loads the built extension
docs/          decisions-api.md, openrouter-decisions.md, youtube-transcripts.md: read before touching those areas
```

## Setup and commands

Node 24 runs the TypeScript directly (type stripping) for tests and scripts; esbuild bundles the extension.

```bash
npm ci                              # fresh checkout
npx playwright install chromium     # once per machine, for e2e and the icons
npm run typecheck                   # tsc, strict, no emit
npm test                            # node:test unit tests (pipeline, shared, extension/src/lib, scripts)
npm run build                       # bundles the extension into extension/dist
npm run e2e                         # build, then Playwright with the unpacked extension
npm run check                       # typecheck + test + build
npm run package                     # extension without source maps → release/unyap-<version>.zip
```

### Look at the extension

Run `npm run build`, then load `extension/dist` in Playwright's Chromium the way `e2e/extension.spec.ts` does
(`launchPersistentContext` with `--load-extension`). The options page is `chrome-extension://<id>/options.html`; for
the watch-page UI, route `https://www.youtube.com/**` to the fixture page in that spec, and replace the worker's
`fetch` with the fake OpenAI there. Screenshot with `page.screenshot` and open the PNG with the Read tool.
Never use a real OpenAI key.

## Conventions

- TypeScript everywhere, strict (see tsconfig.json). Only erasable syntax: no
  `enum`, `namespace` or constructor parameter properties. Import local files
  with their `.ts` extension. Use `import type` for types.
- Runtime dependencies: none. Do not add packages without a strong reason; dev
  dependencies are esbuild, typescript, @types/*, @playwright/test.
- Style: 2-space indent, double quotes, semicolons, trailing commas, lines up to
  ~120 characters. Sparse comments: say why, not what.
- `shared/types.ts` is the contract between the pipeline and the extension. Change it
  deliberately and update every user in the same job.
- Tests: `node:test` + `node:assert/strict` next to the code they cover
  (`pipeline/*.test.ts`, `shared/*.test.ts`, `extension/src/lib/*.test.ts`, `scripts/*.test.ts`).
  E2E with Playwright in `e2e/`. Tests never call OpenAI: they use `createMockClient` or a stubbed `fetch`.
- UI: plain DOM + CSS, no framework. The extension's stylesheet (`extension/static/styles.css`) holds the palette:
  filler grey, context amber, substance green `#2fa84f` (`#3fbf5f` in dark), and accent orange `#e8572a` for
  buttons (`--unyap-accent`).
- User-facing copy speaks as Giuseppe ("I", "me"), never "we" or "us".

## Analysis pipeline (`pipeline/`)

Input is `AnalyzeRequest` (shared/types.ts). Output is `Analysis`.

1. **Input**: `page.ts` builds the request from YouTube's player (video id, title, description, length,
   transcript); `runAnalysis` (`pipeline/analysis.ts`) runs the steps below.
2. **Segment**: windows of `L = max(30 s, ceil(lengthMs / 120))` so there are at
   most 120 segments; segment k covers `[k·L, min((k+1)·L, lengthMs))`. A
   transcript line belongs to the segment containing its `startMs`. Empty
   segments get the text `(no speech)`.
3. **Ask** (the main call; with step 4's refinement there are two `POST /v1/decisions`
   calls per analysis, model `gpt-6-luna`, see docs/decisions-api.md). With OpenRouter, `pipeline/openrouter.ts`
   sends the same two requests to the viewer's chosen model in OpenRouter's shape and translates the answers back,
   so the mapping below reads both providers alike (docs/openrouter-decisions.md). OpenRouter has no refusal
   answer: a missing answer counts as one.
   The prompt layout and every question's wording live in `pipeline/decisions.ts`:
   - `input`: one user message, text: the title, the first 1,000 characters of
     the description, then one line per segment: `[S3 1:00-1:30] <text>`.
     `prompt_cache_key`: the video id.
   - question `delivers` (predicate): does the video, anywhere, actually deliver
     the specific thing its title promises (an answer, a reveal, a result, a
     list, a how-to)?
   - question `payoff` (choice), exactly:
     "Which segment is where the video actually answers its title: where it states the answer, verdict, result or reveal that the title promises? If the answer builds up over several segments, choose the one where it is first clearly stated. Choose none if the promise is never delivered."
     Choices `S1`…`SN` (description: the time range) plus `none` ("the promise
     is never delivered").
   - questions `substance_S<i>` (score), one per segment: judge only that
     segment; levels `filler` (intros, greetings, channel or sponsor plugs,
     like/subscribe requests, teasers of what is coming, repetition, off-topic
     tangents), `context` (background or setup that leads toward the promise
     without delivering it), `substance` (directly delivers information, answers
     or results the title promises).
4. **Map** the answers:
   - `substance = score / 2` (score is the weighted level index 0–2); `level` is
     the level with the highest probability.
   - `payoffProbability` of segment i = the `payoff` probability of `S<i+1>`
     (missing from the list → 0).
   - `payoff` = null when the choice is `none`, else that segment's `startMs`
     (replaced by the refined line's `startMs`, below), index and the answer's
     `confidence`.
   - `delivers` = the predicate probability.
   - `substanceRatio` = runtime of segments with `substance >= 0.5` / total runtime.
   - Refusals: a refused score → substance 0.5, level `context`; refused
     `payoff` → null; refused `delivers` → 0.5. Log every refusal.

   **Refine** the payoff with a second, short call, after the main call is
   mapped and logged:
   - Window: for chosen segment k, the transcript lines whose `startMs` is in
     `[(k−1)·L, (k+1)·L)`, in transcript order (just `[0, L)` for k = 0). Past
     255 lines (the API's choice limit) keep the 255 whose `startMs` is closest
     to `k·L`, the earlier line on a tie, still in transcript order.
   - Skipped, with no call and no log line, when `payoff` is null (`none` or
     refused) or the window holds fewer than 2 lines.
   - `input`: one user message, text: `Title: <title>`, a blank line,
     `Transcript excerpt:`, then one line per window line: `[L2 0:04] <text>`
     (whitespace collapsed, as in segment text). `prompt_cache_key`: the video id.
   - question `start` (choice), exactly:
     "At which line does the speaker start stating the answer, verdict, result or reveal that the title promises? Pick the first line of that statement, so a viewer who starts there hears all of it."
     Choices `L1`…`Lm` in line order (description: the line's time).
   - A valid `L<i>` sets `payoff.startMs` to the i-th window line's `startMs`.
     `payoff.segmentIndex`, `payoff.confidence` and `payoffProbability` stay
     coarse (the main call's), so the refined start may sit in segment k−1.
   - Failure tolerance: a `ModelError` (HTTP status, network error, timeout,
     invalid response such as a choice that is no line) or a refused `start`
     keeps the segment's `startMs`; the analysis is returned as usual. Other
     errors propagate. A main-call failure rejects with its `ModelError`.
5. **Cache**: `runAnalysis` does not cache. The service worker stores each analysis
   locally with `ANALYSIS_VERSION` (in `pipeline/decisions.ts` next to the prompts;
   bump it when prompts change); see "Extension".
6. **Log**: `runAnalysis` hands one `CallLog` per model call to its `log` callback
   (default `logCall`, a JSON line on stdout; the extension passes a no-op and
   shows the calls in debug mode instead): video id, segment count, latency,
   `usage.input_tokens`, cached tokens, refusals. Never log the API key or
   transcripts. Keys `event`, `mode`, `videoId`, `segments`, `latencyMs`,
   `inputTokens`, `cachedTokens`, `refusals`, `ok`, plus `error` on a failure:
   `{"event":"decisions_call","mode":"live","videoId":"abcdefghijk","segments":4,"latencyMs":812,"inputTokens":412,"cachedTokens":256,"refusals":["substance_S2"],"ok":true}`
   The refinement line comes after it and adds `call: "refine"` (only on that
   line) and `lines`, the number of choices m; `segments` is still the video's
   segment count. A refused `start` logs `"refusals":["start"]` with `"ok":true`;
   a failure logs null tokens, `"ok":false` and the `error` reason. A successful
   refinement:
   `{"event":"decisions_call","call":"refine","mode":"live","videoId":"abcdefghijk","segments":4,"lines":3,"latencyMs":118,"inputTokens":95,"cachedTokens":0,"refusals":[],"ok":true}`

The mock client (`createMockClient`, for tests and e2e) replaces both calls with deterministic answers
built from the transcript (for example: segments mentioning subscribe, sponsor,
welcome back or "in this video" are filler; the first segment after 25% of the
runtime with no such words is the payoff; `start` is the first window line with
no such words, or `L1` when every line has one). It must exercise the same
mapping code as live mode.

## Extension

See docs/youtube-transcripts.md for how the transcript is captured; only a real
browser on youtube.com can fetch transcripts.

- `extension/static/manifest.json` (MV3). Content scripts on
  `https://www.youtube.com/*`: one in the `MAIN` world (talks to `#movie_player`,
  captures the transcript), one isolated (UI, talks to the service worker).
  They talk through `CustomEvent`s on `document`.
- The extension runs locally and talks to no server of ours. The viewer picks a
  provider in the options page (`provider`, default `openai`) and pastes their
  own key: `openaiApiKey` (checked by `normalizeApiKey`) or `openrouterApiKey`
  (`normalizeOpenRouterKey`) plus `openrouterModel`, one of the pinned
  `OPENROUTER_MODELS` in `src/lib/settings.ts` (never a `~` alias). The service
  worker runs the analysis itself (`runAnalysis` from `pipeline/analysis.ts`,
  with `createLiveClient` from `pipeline/decisions.ts` or
  `createOpenRouterClient` from `pipeline/openrouter.ts`, bundled by esbuild),
  calling only `https://api.openai.com/v1/decisions` (its one required host
  permission) or `https://openrouter.ai/api/alpha/decisions`. openrouter.ai is
  an optional host permission: the options page asks for it when the viewer
  saves an OpenRouter key, and the worker checks it before calling, so adding
  OpenRouter prompts no existing user on update. Keep
  `pipeline/` free of Node-only imports. At startup the worker restricts
  `chrome.storage.local` to trusted contexts (`setAccessLevel`,
  `TRUSTED_CONTEXTS`), so content scripts cannot read the keys. Model failures
  map to statuses that name the provider: HTTP 401 → "<provider> rejected your
  API key", 402 → credits ran out (OpenRouter), 429 → quota or rate limit,
  network or timeout → "can't reach <provider>"; no openrouter.ai permission →
  "allow openrouter.ai in the options".
- Results are cached in `chrome.storage.local` (`unlimitedStorage`) by
  `src/lib/local-cache.ts`: one entry per video (`analysis:<videoId>`) with the
  save time and `ANALYSIS_VERSION`; entries older than 60 days or from another
  version are misses. Entries older than 60 days are evicted at every worker
  start. The options page has "Clear cache".
- On each watch page `content.ts` first asks the worker for a cached analysis
  and shows it at once (and tells `page.ts` to skip the capture). Otherwise it
  shows "Unyap this video"; a click (or "Analyze every video automatically",
  `autoAnalyze`, default off) sends `unyap:start-capture` to `page.ts`, which
  captures only on request. `content.ts` ignores capture
  messages until it has asked for one, and its buttons accept only `isTrusted`
  clicks, so a page script cannot start an analysis without the viewer's click
  (or auto mode). The worker parses every request with `shared/validate.ts`,
  caps what it can send, and accepts only its own pages or the content script on
  a watch page for the video in that tab. A page script can still send a
  request after a real click; the caps bound what it can cost.
- UI on a watch page: a thin strip just above the progress bar, one block per
  segment coloured by substance, a marker at the payoff; an "Unyap it
  · 12:41" button that sets `video.currentTime`; "Title never delivered" when
  `verdict()` says so. When the analysis has a substance section, "Previous"
  and "Next good part" buttons follow. They move between substance sections
  with `sections`, `nextSubstanceStart` and `previousSubstanceStart` from
  `shared/timeline.ts` (3 s rule: Previous restarts the current section when
  more than 3 s into it, else goes to the one before), seek with
  `video.currentTime`, and are disabled when there is nowhere to go (rechecked
  after every seek and on the video's `timeupdate`). Use `shared/timeline.ts`.
  Rerun on `yt-navigate-finish`.
  Never leave captions switched on if the user had them off, and never leave a
  different caption track selected than the user's.
- Private and unlisted videos are never captured or sent: when the player
  response marks `videoDetails.isPrivate` or
  `microformat.playerMicroformatRenderer.isUnlisted` with anything but a known
  public value (`false`, `"false"` or `0`; a missing field is public), the pill
  shows the skipped status instead. Live streams and premieres (no length yet) say they are not supported.
- Entries: `page.ts` runs in the `MAIN` world (captures the transcript through
  `#movie_player`, no `chrome.*`), `content.ts` in the isolated world (draws the
  UI, messages the service worker), `background.ts` is the service worker (model
  calls, local cache, reads the settings), `options.ts` is the options page.
  Shared code lives in `src/lib/` (`captions.ts`, `settings.ts`, `messages.ts`,
  `local-cache.ts`).
- Debug mode is a locally stored option (`debugMode`, default false). Analysis
  ports relay safe progress from the worker to the isolated content script: the
  questions' wording, the mapped answers, counts and timings — never the prompt's
  per-video content (title, description, transcript) or credentials.
  `src/lib/debug-overlay.ts` renders a translucent black panel in the right third
  of the player, with live call logs and animated judgment progress. Each request
  and response entry expands (a "+" toggle) into the details in words: the
  questions as asked (the predicate, the payoff choice with its segment choices,
  the per-segment score series) and the answers as mapped (delivers probability,
  the chosen payoff, one row per segment, the refinement's chosen line and
  whether it moved the payoff, refusals by name). It identifies
  mock runs and failed/skipped refinements explicitly. It opens only for a new
  analysis: a cached result shows without the panel. Progress is
  batch-based (up to two API requests), and the display persists after completion.
  Navigation removes the panel and disconnects its port. Save and refresh the
  YouTube tab after changing the option.
- `page.ts` hands the capture to `content.ts` with the `unyap:capture`
  `CustomEvent` on `document`; its `detail` is a JSON string (objects do not
  cross JS worlds).
- Load it: `npm run build`, then `chrome://extensions` → Developer mode → Load
  unpacked → `extension/dist`.
- `e2e/extension.spec.ts` loads the built extension in Chromium and verifies its
  manifest, icons, first-run options page, options, local cache and background
  analysis, and the OpenRouter path (options, permission, the model sent). It
  replaces the worker's `fetch` with a fake api.openai.com or openrouter.ai that
  answers with the pipeline's mock client; it never calls a real API.
- YouTube cannot be tested from Playwright: under automation the player's
  timedtext requests come back with empty bodies. Automated checks use a fixture
  page routed onto `https://www.youtube.com/watch?v=…` (with a fake
  `#movie_player`); real YouTube is checked by hand in a real Chrome.

## Git

- Conventional Commits: `feat(pipeline): …`, `fix(extension): …`.
  One focused change per commit. Stage explicit paths. Push only when explicitly requested, and open a pull request for every branch you push.
- End every commit message with a blank line.
