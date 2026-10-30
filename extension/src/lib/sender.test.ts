import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedSender, isAllowedVideoRequest, type SenderLike } from "./sender.ts";

const EXTENSION = "abcdefghijklmnop";
const VIDEO = "ABCDEFGHIJK";
const WATCH = `https://www.youtube.com/watch?v=${VIDEO}`;
const OPTIONS = `chrome-extension://${EXTENSION}/options.html`;

function sender(overrides: Partial<SenderLike> = {}): SenderLike {
  return { id: EXTENSION, url: WATCH, tab: { id: 1 }, ...overrides };
}

describe("isAllowedSender", () => {
  it("accepts the content script on a watch page", () => {
    assert.equal(isAllowedSender(sender(), EXTENSION), true);
  });

  it("accepts an extension page even without a tab", () => {
    assert.equal(isAllowedSender(sender({ url: OPTIONS, tab: undefined }), EXTENSION), true);
  });

  it("rejects another extension", () => {
    assert.equal(isAllowedSender(sender({ id: "another-extension" }), EXTENSION), false);
  });

  it("rejects a sender without a URL", () => {
    assert.equal(isAllowedSender(sender({ url: undefined }), EXTENSION), false);
    assert.equal(isAllowedSender(undefined, EXTENSION), false);
  });

  it("rejects a tabless page that is not an extension page", () => {
    assert.equal(isAllowedSender(sender({ tab: undefined }), EXTENSION), false);
  });

  it("rejects YouTube pages that are not watch pages", () => {
    assert.equal(isAllowedSender(sender({ url: "https://www.youtube.com/" }), EXTENSION), false);
    assert.equal(isAllowedSender(sender({ url: "https://www.youtube.com/results?search_query=x" }), EXTENSION), false);
  });

  it("rejects another origin and malformed URLs", () => {
    assert.equal(isAllowedSender(sender({ url: `https://evil.example/watch?v=${VIDEO}` }), EXTENSION), false);
    assert.equal(isAllowedSender(sender({ url: "not a URL" }), EXTENSION), false);
  });
});

describe("isAllowedVideoRequest", () => {
  it("accepts the content script asking about its own video", () => {
    assert.equal(isAllowedVideoRequest(sender(), EXTENSION, VIDEO), true);
  });

  it("rejects the content script asking about another video", () => {
    assert.equal(isAllowedVideoRequest(sender(), EXTENSION, "ZZZZZZZZZZZ"), false);
  });

  it("rejects a video id that is not a string", () => {
    assert.equal(isAllowedVideoRequest(sender(), EXTENSION, undefined), false);
    assert.equal(isAllowedVideoRequest(sender(), EXTENSION, 42), false);
  });

  it("lets the extension's own page ask about any video", () => {
    assert.equal(isAllowedVideoRequest(sender({ url: OPTIONS, tab: undefined }), EXTENSION, "ZZZZZZZZZZZ"), true);
  });

  it("rejects an unallowed sender", () => {
    assert.equal(isAllowedVideoRequest(sender({ url: "https://www.youtube.com/" }), EXTENSION, VIDEO), false);
    assert.equal(isAllowedVideoRequest(sender({ id: "another-extension" }), EXTENSION, VIDEO), false);
  });
});
