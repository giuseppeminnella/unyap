import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalyzeRequest } from "../shared/types.ts";
import { buildRefinementRequest } from "./decisions.ts";
import { refinementLines, segmentTranscript, windowMsOf } from "./segments.ts";
import { egg, eggRefinementLines } from "./test-fixtures.ts";

function video(lengthSeconds: number, transcript: AnalyzeRequest["transcript"] = []): AnalyzeRequest {
  return { videoId: "abcdefghijk", title: "Test", lengthSeconds, transcript };
}

function line(startMs: number, text = `at ${startMs}`) {
  return { startMs, durationMs: 1000, text };
}

describe("windowMsOf", () => {
  it("is 30 s up to an hour and then a 120th of the length", () => {
    assert.deepEqual([windowMsOf(100_000), windowMsOf(3_600_000), windowMsOf(3_600_001), windowMsOf(21_600_000)], [
      30_000,
      30_000,
      30_001,
      180_000,
    ]);
  });
});

describe("segmentTranscript", () => {
  it("cuts a 600-second video into 20 segments of 30 s", () => {
    const segments = segmentTranscript(video(600));
    assert.equal(segments.length, 20);
    assert.ok(segments.every((segment, i) => segment.startMs === i * 30_000 && segment.endMs === (i + 1) * 30_000));
  });

  it("cuts a 21600-second video into 120 segments of 180 s", () => {
    const segments = segmentTranscript(video(21600));
    assert.equal(segments.length, 120);
    assert.ok(segments.every((segment, i) => segment.startMs === i * 180_000 && segment.endMs === (i + 1) * 180_000));
  });

  it("ends the last segment at the video length", () => {
    const segments = segmentTranscript(video(61));
    assert.deepEqual(
      segments.map((segment) => [segment.startMs, segment.endMs]),
      [[0, 30_000], [30_000, 60_000], [60_000, 61_000]],
    );
  });

  it("puts lines that start past the end into the last segment", () => {
    const segments = segmentTranscript(video(100, [{ startMs: 100_500, durationMs: 1000, text: "Bye" }]));
    assert.equal(segments.length, 4);
    assert.equal(segments[3]?.text, "Bye");
  });

  it("joins a segment's lines, collapses whitespace and marks silence", () => {
    assert.deepEqual(segmentTranscript(egg), [
      { index: 0, startMs: 0, endMs: 30_000, text: "Welcome back to the channel! Don't forget to subscribe." },
      { index: 1, startMs: 30_000, endMs: 60_000, text: "First, bring the water to a boil." },
      { index: 2, startMs: 60_000, endMs: 90_000, text: "Cook for exactly seven minutes." },
      { index: 3, startMs: 90_000, endMs: 100_000, text: "(no speech)" },
    ]);
  });

  it("treats a whitespace-only segment as silence", () => {
    const segments = segmentTranscript(video(30, [{ startMs: 0, durationMs: 1000, text: " \n " }]));
    assert.equal(segments[0]?.text, "(no speech)");
  });
});

describe("refinementLines", () => {
  it("takes the chosen segment and the one before it", () => {
    assert.deepEqual(refinementLines(egg, 1), eggRefinementLines);
  });

  it("takes only the first segment for k = 0", () => {
    assert.deepEqual(refinementLines(egg, 0), egg.transcript.slice(0, 2));
  });

  it("leaves out lines outside [(k-1)L, (k+1)L)", () => {
    const request = video(600, [line(119_999), line(120_000), line(150_000), line(179_999), line(180_000)]);
    assert.deepEqual(refinementLines(request, 5), [line(120_000), line(150_000), line(179_999)]);
  });

  it("keeps the 255 lines closest to the segment start, the earlier one on a tie, in transcript order", () => {
    // 300 lines every 200 ms in [120 s, 180 s), each pair 100 ms, 300 ms, ... around the 150 s start ties.
    const inWindow = Array.from({ length: 300 }, (_, i) => line(120_100 + 200 * i));
    const request = video(600, [line(60_000), ...inWindow, line(180_000)]);
    const expected = inWindow.filter((kept) => kept.startMs >= 124_500 && kept.startMs <= 175_300);
    assert.equal(expected.length, 255);

    const lines = refinementLines(request, 5);
    assert.deepEqual(lines, expected);
    const [question] = buildRefinementRequest(request, lines).questions;
    assert.ok(question?.type === "choice");
    const names = Array.from({ length: 255 }, (_, i) => `L${i + 1}`);
    assert.deepEqual(question.choices.map((choice) => choice.value), names);
  });
});
