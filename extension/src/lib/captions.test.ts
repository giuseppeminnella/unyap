import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  captionJson3Url,
  captionRequestKind,
  chooseTrack,
  findCaptionUrl,
  isPrivateOrUnlisted,
  parseJson3,
  type CaptionTrack,
} from "./captions.ts";

const VIDEO = "r4n2wTDCxFo";
const PLAYER_URL =
  `https://www.youtube.com/api/timedtext?v=${VIDEO}&ei=abc&caps=asr&opi=112496729&xoaf=5&hl=en&ip=0.0.0.0` +
  "&ipbits=0&expire=1792800000&sparams=ip,ipbits,expire,v,ei,caps,opi,xoaf&signature=8F1C0A.33B2D4&key=yt8" +
  "&kind=asr&lang=en&potc=1&pot=MnQBH2xR-u_8fK1Q%3D%3D&fmt=srv3&xorb=2&xobt=3&xovt=3&c=WEB&cver=2.20261020.01.00" +
  "&tlang=de";

// Shaped like a real player response (0dMWzcyJaUk): auto-translated asr tracks first, the manual en-US track at index
// 4, and the audio track naming index 4 as its default caption track.
const ASR_LANGUAGES = ["ar", "bn", "nl-NL", "en", "fr-FR", "de-DE", "hi", "id", "it", "ja", "ko", "pl", "pt-BR", "ru"];
const LISTED_TRACKS: (CaptionTrack & { vssId: string; isTranslatable?: boolean })[] = [
  ...ASR_LANGUAGES.slice(0, 4).map((languageCode) => ({ languageCode, kind: "asr", vssId: `a.${languageCode}` })),
  { languageCode: "en-US", vssId: ".en-US", isTranslatable: true },
  ...[...ASR_LANGUAGES.slice(4), "es-ES", "th", "tr", "uk", "vi", "zh-Hans"].map((languageCode) => ({
    languageCode,
    kind: "asr",
    vssId: `a.${languageCode}`,
  })),
];
const AUDIO_TRACK = {
  captionTrackIndices: [4, 3, 0, 1, 2, 5, 6, 7],
  defaultCaptionTrackIndex: 4,
  hasDefaultTrack: true,
  audioTrackId: "en-US.4",
  captionsInitialState: "CAPTIONS_INITIAL_STATE_OFF_RECOMMENDED",
};

describe("chooseTrack", () => {
  it("takes the default audio track's defaultCaptionTrackIndex: the manual en-US over a leading ar asr", () => {
    assert.equal(LISTED_TRACKS.length, 21);
    assert.equal(LISTED_TRACKS.filter((track) => track.kind === "asr").length, 20);
    const tracklist = { captionTracks: LISTED_TRACKS, audioTracks: [AUDIO_TRACK], defaultAudioTrackIndex: 0 };
    assert.deepEqual(chooseTrack(tracklist), { languageCode: "en-US", vssId: ".en-US", isTranslatable: true });
  });

  it("takes the first captionTrackIndices entry when there is no defaultCaptionTrackIndex", () => {
    const { defaultCaptionTrackIndex: _, ...withoutDefault } = AUDIO_TRACK;
    const tracklist = { captionTracks: LISTED_TRACKS, audioTracks: [withoutDefault], defaultAudioTrackIndex: 0 };
    assert.equal(chooseTrack(tracklist)?.languageCode, "en-US");
    const enFirst = { ...withoutDefault, captionTrackIndices: [3, 4, 0] };
    assert.deepEqual(chooseTrack({ ...tracklist, audioTracks: [enFirst] }), LISTED_TRACKS[3]);
  });

  it("uses the audio track at defaultAudioTrackIndex, or the first one without it", () => {
    const audioTracks = [{ captionTrackIndices: [0], defaultCaptionTrackIndex: 0 }, AUDIO_TRACK];
    const tracklist = { captionTracks: LISTED_TRACKS, audioTracks };
    assert.equal(chooseTrack({ ...tracklist, defaultAudioTrackIndex: 1 })?.languageCode, "en-US");
    assert.equal(chooseTrack(tracklist)?.languageCode, "ar");
  });

  it("keeps the old choice without audioTracks", () => {
    assert.deepEqual(chooseTrack({ captionTracks: LISTED_TRACKS }), LISTED_TRACKS[0]);
  });

  it("prefers a manual en track over the asr en track", () => {
    assert.deepEqual(chooseTrack({ captionTracks: [{ languageCode: "en", kind: "asr" }, { languageCode: "en" }] }), {
      languageCode: "en",
    });
  });

  it("prefers a manual en-GB track over the asr en track", () => {
    const captionTracks = [{ languageCode: "de" }, { languageCode: "en", kind: "asr" }, { languageCode: "en-GB" }];
    assert.deepEqual(chooseTrack({ captionTracks }), { languageCode: "en-GB" });
  });

  it("prefers the asr en track over a manual de track", () => {
    assert.deepEqual(chooseTrack({ captionTracks: [{ languageCode: "de" }, { languageCode: "en", kind: "asr" }] }), {
      languageCode: "en",
      kind: "asr",
    });
  });

  it("takes the first track when there is no asr track", () => {
    assert.deepEqual(chooseTrack({ captionTracks: [{ languageCode: "fr" }, { languageCode: "en" }] }), {
      languageCode: "fr",
    });
  });

  it("is null without tracks", () => {
    assert.equal(chooseTrack({}), null);
    assert.equal(chooseTrack({ captionTracks: [], audioTracks: [AUDIO_TRACK] }), null);
  });
});

describe("findCaptionUrl", () => {
  it("skips entries without pot", () => {
    const withoutPot = PLAYER_URL.replace(/&pot=[^&]*/, "");
    assert.equal(findCaptionUrl([withoutPot], VIDEO), null);
    assert.equal(findCaptionUrl([withoutPot.replace("potc=1", "potc=1&pot=")], VIDEO), null);
  });

  it("skips entries for another video", () => {
    assert.equal(findCaptionUrl([PLAYER_URL.replace(`v=${VIDEO}`, "v=dQw4w9WgXcQ")], VIDEO), null);
  });

  it("skips entries on another host or path", () => {
    const urls = [
      PLAYER_URL.replace("https://www.youtube.com", "https://m.youtube.com"),
      PLAYER_URL.replace("https://www.youtube.com", "http://www.youtube.com"),
      PLAYER_URL.replace("/api/timedtext", "/api/stats/qoe"),
      "https://www.youtube.com/watch?v=r4n2wTDCxFo&pot=x",
      "not a url",
    ];
    assert.equal(findCaptionUrl(urls, VIDEO), null);
  });

  it("returns the last of several matches", () => {
    const later = PLAYER_URL.replace("pot=MnQBH2xR-u_8fK1Q%3D%3D", "pot=later");
    const other = PLAYER_URL.replace(`v=${VIDEO}`, "v=dQw4w9WgXcQ");
    assert.equal(findCaptionUrl([PLAYER_URL, later, other], VIDEO), later);
  });
});

describe("captionRequestKind", () => {
  const withoutPot = PLAYER_URL.replace(/&potc=1&pot=[^&]*/, "");

  it('is "pot" for this video\'s request with a token', () => {
    assert.equal(captionRequestKind(PLAYER_URL, VIDEO), "pot");
  });

  it('is "no-pot" for this video\'s request sent before the player had a token', () => {
    assert.equal(captionRequestKind(withoutPot, VIDEO), "no-pot");
    assert.equal(captionRequestKind(`${withoutPot}&pot=`, VIDEO), "no-pot");
  });

  it("is null for another video, host or path, and for anything not a URL", () => {
    for (const raw of [PLAYER_URL, withoutPot]) {
      assert.equal(captionRequestKind(raw, "dQw4w9WgXcQ"), null);
      assert.equal(captionRequestKind(raw.replace("https://www.youtube.com", "https://m.youtube.com"), VIDEO), null);
      assert.equal(captionRequestKind(raw.replace("/api/timedtext", "/api/stats/qoe"), VIDEO), null);
    }
    assert.equal(captionRequestKind("not a url", VIDEO), null);
  });
});

describe("captionJson3Url", () => {
  const manual = new URL(captionJson3Url(PLAYER_URL, { languageCode: "en-GB" })).searchParams;
  const asr = new URL(captionJson3Url(PLAYER_URL.replace("&kind=asr", ""), { languageCode: "en", kind: "asr" }))
    .searchParams;

  it("sets lang to the track's language", () => {
    assert.equal(manual.get("lang"), "en-GB");
    assert.equal(asr.get("lang"), "en");
  });

  it("sets kind=asr for an asr track and removes kind for a manual one", () => {
    assert.equal(asr.get("kind"), "asr");
    assert.equal(manual.has("kind"), false);
  });

  it("replaces fmt with json3", () => {
    assert.deepEqual(manual.getAll("fmt"), ["json3"]);
    const twice = new URL(captionJson3Url(`${PLAYER_URL}&fmt=vtt`, { languageCode: "en" }));
    assert.deepEqual(twice.searchParams.getAll("fmt"), ["json3"]);
  });

  it("removes tlang", () => assert.equal(manual.has("tlang"), false));

  it("keeps the host, path and every other parameter unchanged", () => {
    const result = new URL(captionJson3Url(PLAYER_URL, { languageCode: "en-GB" }));
    assert.equal(`${result.origin}${result.pathname}`, "https://www.youtube.com/api/timedtext");
    for (const [name, value] of new URL(PLAYER_URL).searchParams) {
      if (["lang", "kind", "fmt", "tlang"].includes(name)) continue;
      assert.equal(manual.get(name), value, name);
    }
    assert.equal(manual.get("pot"), "MnQBH2xR-u_8fK1Q==");
    assert.equal(manual.get("sparams"), "ip,ipbits,expire,v,ei,caps,opi,xoaf");
  });
});

describe("parseJson3", () => {
  // Shaped like a real json3 response: a header event without segs, line-break events, multi-seg asr events.
  const fixture = {
    wireMagic: "pb3",
    pens: [{}],
    wsWinStyles: [{}],
    wpWinPositions: [{}],
    events: [
      { tStartMs: 0, dDurationMs: 1_203_440, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
      {
        tStartMs: 160,
        dDurationMs: 4_560,
        wWinId: 1,
        segs: [{ utf8: "welcome", acAsrConf: 0 }, { utf8: " back", tOffsetMs: 320 }, { utf8: " everyone", tOffsetMs: 640 }],
      },
      { tStartMs: 2_710, dDurationMs: 2_010, wWinId: 1, aAppend: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 2_720, dDurationMs: 4_120, wWinId: 1, segs: [{ utf8: "today  we\nlook at" }, { utf8: " espresso " }] },
      { tStartMs: 6_840, wWinId: 1, segs: [{ utf8: "[Music]" }] },
      { tStartMs: 7_000, dDurationMs: 100, segs: [{ utf8: "   " }] },
      { dDurationMs: 500, segs: [{ utf8: "no start time" }] },
      { tStartMs: "9000", dDurationMs: 500, segs: [{ utf8: "string start time" }] },
      { tStartMs: 9_500, dDurationMs: 1_000, segs: [{ utf8: "dose " }, { noText: true }, { utf8: "18 grams" }] },
    ],
  };

  it("turns each event with text into a line with collapsed whitespace", () => {
    assert.deepEqual(parseJson3(fixture), [
      { startMs: 160, durationMs: 4_560, text: "welcome back everyone" },
      { startMs: 2_720, durationMs: 4_120, text: "today we look at espresso" },
      { startMs: 6_840, durationMs: 0, text: "[Music]" },
      { startMs: 9_500, durationMs: 1_000, text: "dose 18 grams" },
    ]);
  });

  it("skips events without segs and events whose text is empty", () => {
    const texts = parseJson3(fixture).map((line) => line.text);
    assert.equal(texts.includes(""), false);
    assert.equal(parseJson3({ events: [{ tStartMs: 0, dDurationMs: 10 }, { tStartMs: 5, segs: [{ utf8: "\n" }] }] }).length, 0);
  });

  it("uses 0 when dDurationMs is absent", () => {
    assert.deepEqual(parseJson3({ events: [{ tStartMs: 42, segs: [{ utf8: "hi" }] }] }), [
      { startMs: 42, durationMs: 0, text: "hi" },
    ]);
  });

  it("skips events without a numeric tStartMs", () => {
    const texts = parseJson3(fixture).map((line) => line.text);
    assert.equal(texts.includes("no start time"), false);
    assert.equal(texts.includes("string start time"), false);
  });

  it("returns [] for anything not shaped like json3", () => {
    for (const data of [null, undefined, "", 42, [], {}, { events: null }, { events: "x" }, "<transcript/>"]) {
      assert.deepEqual(parseJson3(data), []);
    }
  });
});

describe("isPrivateOrUnlisted", () => {
  const response = (isPrivate: unknown, isUnlisted: unknown) => ({
    videoDetails: { videoId: VIDEO, isPrivate },
    microformat: { playerMicroformatRenderer: { isUnlisted } },
  });

  it("is true for a private video", () => assert.equal(isPrivateOrUnlisted(response(true, false)), true));

  it("is true for an unlisted video", () => assert.equal(isPrivateOrUnlisted(response(false, true)), true));

  it("is false when both are false", () => assert.equal(isPrivateOrUnlisted(response(false, false)), false));

  it("is false when the fields are missing", () => {
    assert.equal(isPrivateOrUnlisted({}), false);
    assert.equal(isPrivateOrUnlisted({ videoDetails: { videoId: VIDEO } }), false);
  });

  it("fails closed when a flag is not a known false value", () => {
    for (const value of [true, "true", 1, 2, {}, null]) {
      assert.equal(isPrivateOrUnlisted(response(value, false)), true);
      assert.equal(isPrivateOrUnlisted(response(false, value)), true);
    }
  });

  it('is false for the known public values false, "false" and 0', () => {
    for (const value of [false, "false", 0]) {
      assert.equal(isPrivateOrUnlisted(response(value, value)), false);
    }
  });

  it("is false for null", () => assert.equal(isPrivateOrUnlisted(null), false));
});
