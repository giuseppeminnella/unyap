import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalyzeRequest } from "./types.ts";
import {
  MAX_CAPTION_START_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_LANGUAGE_CHARS,
  MAX_LENGTH_SECONDS,
  MAX_TITLE_CHARS,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_LINES,
  parseAnalyzeRequest,
} from "./validate.ts";

const VALID: AnalyzeRequest = {
  videoId: "abcdefghijk",
  title: "A title",
  description: "A description",
  lengthSeconds: 600,
  language: "en",
  transcript: [{ startMs: 0, durationMs: 1000, text: "Hello" }],
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...VALID, ...overrides };
}

describe("parseAnalyzeRequest", () => {
  it("returns a valid request and leaves the input alone", () => {
    const input = request();
    assert.deepEqual(parseAnalyzeRequest(input), VALID);
    assert.deepEqual(input, request());
  });

  it("keeps description and language absent when they are absent", () => {
    const { description: _description, language: _language, ...rest } = VALID;
    assert.deepEqual(parseAnalyzeRequest(rest), rest);
  });

  it("truncates over-long title, description and language", () => {
    const parsed = parseAnalyzeRequest(request({
      title: "t".repeat(MAX_TITLE_CHARS + 10),
      description: "d".repeat(MAX_DESCRIPTION_CHARS + 10),
      language: "l".repeat(MAX_LANGUAGE_CHARS + 10),
    }));
    assert.equal(parsed?.title.length, MAX_TITLE_CHARS);
    assert.equal(parsed?.description?.length, MAX_DESCRIPTION_CHARS);
    assert.equal(parsed?.language?.length, MAX_LANGUAGE_CHARS);
  });

  it("rejects anything that is not an object", () => {
    for (const value of [null, undefined, "a request", 42, []]) assert.equal(parseAnalyzeRequest(value), null);
  });

  it("rejects a video id that is not eleven URL-safe characters", () => {
    for (const videoId of ["", "short", "abcdefghijkl", "abcdefghij/", "../abcdefghij"]) {
      assert.equal(parseAnalyzeRequest(request({ videoId })), null);
    }
  });

  it("rejects a missing or non-string title", () => {
    for (const title of [undefined, null, 42, ["a title"]]) {
      assert.equal(parseAnalyzeRequest(request({ title })), null);
    }
  });

  it("rejects a length that is not a finite number in range", () => {
    for (const lengthSeconds of [undefined, null, "600", 0, -1, Number.NaN, Infinity, -Infinity, MAX_LENGTH_SECONDS + 1]) {
      assert.equal(parseAnalyzeRequest(request({ lengthSeconds })), null);
    }
    assert.equal(parseAnalyzeRequest(request({ lengthSeconds: MAX_LENGTH_SECONDS }))?.lengthSeconds, MAX_LENGTH_SECONDS);
  });

  it("rejects a description or language of the wrong type", () => {
    assert.equal(parseAnalyzeRequest(request({ description: 42 })), null);
    assert.equal(parseAnalyzeRequest(request({ language: 42 })), null);
  });

  it("rejects a transcript that is not a non-empty array within the line cap", () => {
    for (const transcript of [undefined, null, "text", []]) {
      assert.equal(parseAnalyzeRequest(request({ transcript })), null);
    }
    const tooMany = Array.from({ length: MAX_TRANSCRIPT_LINES + 1 }, () => VALID.transcript[0]);
    assert.equal(parseAnalyzeRequest(request({ transcript: tooMany })), null);
  });

  it("rejects a malformed line", () => {
    const line = VALID.transcript[0]!;
    for (const bad of [null, 42, { ...line, startMs: "0" }, { ...line, startMs: -1 }, { ...line, startMs: MAX_CAPTION_START_MS + 1 }]) {
      assert.equal(parseAnalyzeRequest(request({ transcript: [bad] })), null);
    }
    for (const bad of [{ ...line, durationMs: "1000" }, { ...line, durationMs: -1 }, { ...line, durationMs: Infinity }]) {
      assert.equal(parseAnalyzeRequest(request({ transcript: [bad] })), null);
    }
    assert.equal(parseAnalyzeRequest(request({ transcript: [{ ...line, text: 42 }] })), null);
    assert.equal(
      parseAnalyzeRequest(request({ transcript: [{ ...line, startMs: MAX_CAPTION_START_MS }] }))?.transcript[0]?.startMs,
      MAX_CAPTION_START_MS,
    );
  });

  it("rejects a transcript past the text cap", () => {
    const text = "x".repeat(MAX_TRANSCRIPT_CHARS + 1);
    assert.equal(parseAnalyzeRequest(request({ transcript: [{ startMs: 0, durationMs: 1000, text }] })), null);
  });

  it("keeps an empty line text", () => {
    const transcript = [{ startMs: 0, durationMs: 1000, text: "" }];
    assert.deepEqual(parseAnalyzeRequest(request({ transcript }))?.transcript, transcript);
  });
});
