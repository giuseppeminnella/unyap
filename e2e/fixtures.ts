// A video for the extension spec. The id is made up; the pipeline's mock client makes its analysis deterministic.
import type { AnalyzeRequest } from "../shared/types.ts";

/** Mock result: filler, substance, substance, filler; the point at the second segment; verdict "delivered". */
export const e2eEggVideo: AnalyzeRequest = {
  videoId: "e2eEggVideo",
  title: "How to boil an egg",
  lengthSeconds: 100,
  transcript: [
    { startMs: 0, durationMs: 4000, text: "Welcome back to the channel!" },
    { startMs: 4000, durationMs: 3000, text: "Don't forget to\nsubscribe." },
    { startMs: 31000, durationMs: 5000, text: "First, bring the water to a boil." },
    { startMs: 62000, durationMs: 4000, text: "Cook for exactly seven minutes." },
  ],
};
