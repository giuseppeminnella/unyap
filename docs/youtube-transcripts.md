# Getting a YouTube transcript (findings, 2026-10-23)

Tested from a Mac, from a cloud server, and inside a logged-in Chrome tab.

## What does not work

- Fetching a caption track's `baseUrl` (from `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`)
  returns HTTP 200 with an **empty body**, from any machine, even inside the YouTube page.
  YouTube now requires a proof-of-origin token (`pot=`) that only its player generates.
- The innertube `POST /youtubei/v1/get_transcript` endpoint (what "Show transcript" uses)
  returns `400 FAILED_PRECONDITION`, from the server, the Mac and the page alike.
- So no server can fetch transcripts. Only the browser extension can.

## What works (inside a youtube.com/watch page)

1. Observe resource timings for `/api/timedtext` requests that carry `pot=`:
   `new PerformanceObserver(...).observe({ type: "resource", buffered: true })`.
   No need to patch `fetch` or `XMLHttpRequest`.
2. If captions are off, make the player request them, from the page's main world:
   ```js
   const player = document.querySelector("#movie_player");
   player.loadModule("captions");
   const tracks = player.getOption("captions", "tracklist") || [];
   player.setOption("captions", "track", tracks[0] ?? { languageCode: "en" });
   ```
   The request appears in about 1 second.
3. Copy that URL, keep `pot`, `potc`, `c`, `cver` and the signature params, and change only:
   - `lang` to the track you want, and `kind=asr` for the auto-generated track
     (omit `kind` for a manual track);
   - `fmt=json3`; drop `tlang`.
   Fetching it from the page returns the whole transcript as json3:
   `{ events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }`. Skip events without `segs`
   and events whose text is only `"\n"`.
4. Restore the user's caption state: if captions were off,
   `player.setOption("captions", "track", {})` then `player.unloadModule("captions")`.
   If captions were on and the capture had to select a track, set the user's previous
   track back: read it with `player.getOption("captions", "track")` before selecting,
   then `player.setOption("captions", "track", previous)` afterwards.

5. The refetch is sometimes empty on the first try right after the page loads.
   Retry the whole capture (trigger, observe, refetch) up to 3 times, about 1 s apart,
   with `observe({ type: "resource", buffered: false })` on retries so a stale entry
   is not reused.

## Automated browsers get nothing

In Playwright-driven Chromium (headless or the new headless mode) the player's
own pot-bearing request returns an empty body: YouTube's bot detection rejects
the token. The same happens in the Claude desktop app's built-in browser. Do not
work around it (no user-agent spoofing, no hiding `navigator.webdriver`). Test
the capture flow against a local fixture that fakes `#movie_player`, and verify
on real YouTube in a real Chrome.

## Facts that shape the design

- The token is bound to the video (and page load): a token captured on one video
  returns an empty body for another. Capture once per video.
- Right after a fresh page load the player's caption requests carry no `pot`
  (measured on three videos: the first, ~1.5 s after load, has none; requests
  triggered from ~9–10 s after load do). A request without `pot` means the token
  is not ready yet: never refetch it. Restore the caption state, trigger again
  about 2 s later (waiting at most ~3 s for that request, so captions are forced
  on only briefly), and keep going for up to ~30 s after the capture started.
- `player.getPlayerResponse()` gives `videoDetails` (`videoId`, `title`,
  `lengthSeconds`, `shortDescription`) and the caption track list
  (`languageCode`, `kind: "asr"` for auto-generated). It also gives
  `videoDetails.isPrivate` and `microformat.playerMicroformatRenderer.isUnlisted`;
  Unyap skips private and unlisted videos (never captured or sent).
- `captionTracks` can start with many auto-translated `asr` tracks in other
  languages (measured: 20 `asr` tracks from `ar`, the manual `en-US` at index 4).
  The track to use is the one the player names:
  `audioTracks[defaultAudioTrackIndex ?? 0].defaultCaptionTrackIndex`, else that
  audio track's first `captionTrackIndices` entry. Only without `audioTracks` fall
  back to the rule below.
- Prefer a manual track in the video's own language (better punctuation), else
  the `asr` track.
- YouTube is a single-page app: listen for `yt-navigate-finish` on `document` to
  rerun on every new video.
- Measured: a 42-minute video gave 998 manual caption lines; a 34-minute one gave
  1,769 auto-generated lines.
