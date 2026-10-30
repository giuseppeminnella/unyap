# Unyap

**Impatience, now a browser extension.**

Long YouTube videos often spend ten minutes circling the thing their title
promised. Unyap is a Chrome extension that finds the moment the video actually
delivers, shows which parts are filler, context or substance, and gives you an
"Unyap it" button plus "Previous" / "Next good part".

- **Your own key, almost free.** The extension runs in your browser and calls
  a Decisions API with your key: OpenAI's, or a decision model through
  [OpenRouter](https://openrouter.ai), which serves models from several
  companies with one key. One request asks every question about a video at
  once, plus a short second one to pin the exact line. About $0.001 per new
  video on OpenAI, less on most OpenRouter models; results are cached in the
  browser for 60 days, so repeats are free.
- **Nothing goes to me.** The video's text goes only to the provider you pick
  (OpenAI, or OpenRouter and the company behind the model), and I store no
  data. Private and unlisted videos are skipped. [Privacy policy](https://giuseppe.dev/unyap/privacy/).
- **Your responsibility.** You run Unyap on your computer with your own key, at
  your own responsibility and cost; it comes as is, without warranty.
  [Terms of use](https://giuseppe.dev/unyap/terms/).
- **Home page:** https://giuseppe.dev/unyap/, on my blog.

## Install

Get it from the [Chrome Web Store](https://chromewebstore.google.com/detail/unyap/jbmhegfmbdlkpiilfnjpmdkflfooobfe),
choose OpenAI or OpenRouter in the options page that opens and paste your key, then click
**Unyap this video** on any YouTube video with captions.

**Debug mode** (in the options): a panel over the player shows each Decisions
API request, its timing and token counts, and the judgment progress. Save, then
refresh the YouTube tab.

## Build from source

1. `npm ci && npm run build` (Node 24 or later).
2. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**
   and select `extension/dist`. To update, rebuild, click the extension's reload
   button and refresh your YouTube tabs.

`npm run check` runs the type check, the unit tests and the build; `npm run e2e`
runs the Playwright tests. [AGENTS.md](AGENTS.md) describes the layout, the
conventions and how the analysis works.

## License

[MIT](LICENSE)
