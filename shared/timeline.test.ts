import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatTime,
  nextSubstanceStart,
  payoffLeftPct,
  previousSubstanceStart,
  sections,
  stripBlocks,
  verdict,
} from "./timeline.ts";
import type { Analysis, SubstanceLevel } from "./types.ts";

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    videoId: "abcdefghijk",
    title: "Test",
    lengthSeconds: 120,
    segments: [
      { index: 0, startMs: 0, endMs: 60_000, substance: 0.1, level: "filler", payoffProbability: 0.1 },
      { index: 1, startMs: 60_000, endMs: 120_000, substance: 0.9, level: "substance", payoffProbability: 0.9 },
    ],
    payoff: { startMs: 60_000, segmentIndex: 1, confidence: 0.8 },
    delivers: 0.9,
    substanceRatio: 0.5,
    model: "mock",
    createdAt: "2026-10-23T00:00:00.000Z",
    cached: false,
    ...overrides,
  };
}

describe("formatTime", () => {
  it("formats minutes and hours", () => {
    assert.equal(formatTime(0), "0:00");
    assert.equal(formatTime(245_000), "4:05");
    assert.equal(formatTime(3_729_000), "1:02:09");
  });
});

describe("verdict", () => {
  it("is delivered with a confident payoff", () => assert.equal(verdict(analysis()), "delivered"));
  it("is uncertain with a weak payoff", () =>
    assert.equal(verdict(analysis({ payoff: { startMs: 0, segmentIndex: 0, confidence: 0.2 } })), "uncertain"));
  it("is never-delivered with a low delivers probability", () =>
    assert.equal(verdict(analysis({ delivers: 0.1 })), "never-delivered"));
  it("is never-delivered without a payoff", () => assert.equal(verdict(analysis({ payoff: null })), "never-delivered"));
});

describe("stripBlocks", () => {
  it("positions each segment as a share of the video", () => {
    assert.deepEqual(
      stripBlocks(analysis()).map((b) => [b.leftPct, b.widthPct]),
      [
        [0, 50],
        [50, 50],
      ],
    );
  });
});

describe("payoffLeftPct", () => {
  it("places the payoff marker", () => assert.equal(payoffLeftPct(analysis()), 50));
  it("is null without a payoff", () => assert.equal(payoffLeftPct(analysis({ payoff: null })), null));
});

/** An analysis with one 30 s segment per level, in order. */
function levels(...list: SubstanceLevel[]): Analysis {
  return analysis({
    lengthSeconds: list.length * 30,
    segments: list.map((level, index) => ({
      index,
      startMs: index * 30_000,
      endMs: (index + 1) * 30_000,
      substance: level === "substance" ? 0.9 : level === "context" ? 0.5 : 0.1,
      level,
      payoffProbability: 0.1,
    })),
    payoff: { startMs: 31_000, segmentIndex: 1, confidence: 0.8 },
  });
}

// Filler, context, substance, substance, filler, substance, filler, substance.
const FCSSFSFS = levels("filler", "context", "substance", "substance", "filler", "substance", "filler", "substance");

const NEXT_CASES: [number, number | null][] = [
  [0, 60_000],
  [58_999, 60_000],
  [59_000, 150_000],
  [59_999.999, 150_000],
  [60_000, 150_000],
  [100_000, 150_000],
  [130_000, 150_000],
  [208_999, 210_000],
  [210_000, null],
  [250_000, null],
];

const PREVIOUS_CASES: [number, number | null][] = [
  [0, null],
  [45_000, null],
  [61_000, null],
  [63_000, null],
  [63_001, 60_000],
  [100_000, 60_000],
  [130_000, 60_000],
  [150_000, 60_000],
  [153_000, 60_000],
  [153_001, 150_000],
  [210_000, 150_000],
  [250_000, 210_000],
];

function chain(step: (currentMs: number) => number | null, fromMs: number): (number | null)[] {
  const result: (number | null)[] = [];
  let currentMs: number | null = fromMs;
  while (currentMs !== null) {
    currentMs = step(currentMs);
    result.push(currentMs);
  }
  return result;
}

describe("sections", () => {
  it("merges consecutive segments with the same level", () => {
    assert.deepEqual(sections(FCSSFSFS), [
      { level: "filler", startMs: 0, endMs: 30_000, firstIndex: 0, lastIndex: 0 },
      { level: "context", startMs: 30_000, endMs: 60_000, firstIndex: 1, lastIndex: 1 },
      { level: "substance", startMs: 60_000, endMs: 120_000, firstIndex: 2, lastIndex: 3 },
      { level: "filler", startMs: 120_000, endMs: 150_000, firstIndex: 4, lastIndex: 4 },
      { level: "substance", startMs: 150_000, endMs: 180_000, firstIndex: 5, lastIndex: 5 },
      { level: "filler", startMs: 180_000, endMs: 210_000, firstIndex: 6, lastIndex: 6 },
      { level: "substance", startMs: 210_000, endMs: 240_000, firstIndex: 7, lastIndex: 7 },
    ]);
  });
  it("is empty without segments", () => assert.deepEqual(sections(analysis({ segments: [] })), []));
});

describe("nextSubstanceStart", () => {
  for (const [currentMs, expected] of NEXT_CASES) {
    it(`goes from ${currentMs} to ${expected}`, () => assert.equal(nextSubstanceStart(FCSSFSFS, currentMs), expected));
  }
  it("chains through every good part from the start", () =>
    assert.deepEqual(chain((ms) => nextSubstanceStart(FCSSFSFS, ms), 0), [60_000, 150_000, 210_000, null]));
});

describe("previousSubstanceStart", () => {
  for (const [currentMs, expected] of PREVIOUS_CASES) {
    it(`goes from ${currentMs} to ${expected}`, () =>
      assert.equal(previousSubstanceStart(FCSSFSFS, currentMs), expected));
  }
  it("chains back through every good part from the last one", () =>
    assert.deepEqual(chain((ms) => previousSubstanceStart(FCSSFSFS, ms), 210_000), [150_000, 60_000, null]));
});

describe("substance navigation without good parts", () => {
  const noSubstance = levels("filler", "context", "context", "filler", "filler", "context", "filler", "filler");
  it("has nowhere to go at the start, mid-video and the end", () => {
    for (const currentMs of [0, 120_000, 240_000]) {
      assert.equal(nextSubstanceStart(noSubstance, currentMs), null);
      assert.equal(previousSubstanceStart(noSubstance, currentMs), null);
    }
  });
  it("still returns the sections", () =>
    assert.deepEqual(
      sections(noSubstance).map((s) => [s.level, s.firstIndex, s.lastIndex]),
      [
        ["filler", 0, 0],
        ["context", 1, 2],
        ["filler", 3, 4],
        ["context", 5, 5],
        ["filler", 6, 7],
      ],
    ));
});

describe("substance navigation ignores the payoff and the verdict", () => {
  const neverDelivered = { ...FCSSFSFS, payoff: null, delivers: 0 };
  it("gives the same answers with no payoff and delivers 0", () => {
    assert.equal(verdict(neverDelivered), "never-delivered");
    for (const [currentMs, expected] of NEXT_CASES) {
      assert.equal(nextSubstanceStart(neverDelivered, currentMs), expected);
    }
    for (const [currentMs, expected] of PREVIOUS_CASES) {
      assert.equal(previousSubstanceStart(neverDelivered, currentMs), expected);
    }
  });
});
