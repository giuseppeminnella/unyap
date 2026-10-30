// Which contexts may talk to the worker: the extension's own pages, and the content script on a YouTube watch page.
// A content script may only ask about the video in its tab.
import { watchVideoId } from "./messages.ts";

/** The parts of chrome.runtime.MessageSender this check reads. */
export interface SenderLike {
  id?: string | undefined;
  url?: string | undefined;
  tab?: { id?: number | undefined } | undefined;
}

function extensionPage(sender: SenderLike, extensionId: string): boolean {
  return sender.url?.startsWith(`chrome-extension://${extensionId}/`) === true;
}

function watchIdOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://www.youtube.com" ? watchVideoId(parsed) : null;
  } catch {
    return null;
  }
}

/** The extension's own page, or the content script on a watch page. */
export function isAllowedSender(sender: SenderLike | undefined, extensionId: string): boolean {
  if (sender === undefined || sender.id !== extensionId || sender.url === undefined) return false;
  if (extensionPage(sender, extensionId)) return true;
  return sender.tab !== undefined && watchIdOf(sender.url) !== null;
}

/** The extension's own page, or a content script asking about the video its tab shows. */
export function isAllowedVideoRequest(
  sender: SenderLike | undefined,
  extensionId: string,
  videoId: unknown,
): boolean {
  if (!isAllowedSender(sender, extensionId) || sender === undefined) return false;
  if (extensionPage(sender, extensionId)) return true;
  return typeof videoId === "string" && sender.url !== undefined && watchIdOf(sender.url) === videoId;
}
