import type { TestContext } from "node:test";
import { format } from "node:util";

/** Swallows console.log and console.error for the rest of the test; the returned function lists what was written. */
export function captureConsole(t: TestContext): () => string[] {
  const log = t.mock.method(console, "log", () => {});
  const error = t.mock.method(console, "error", () => {});
  return () => [...log.mock.calls, ...error.mock.calls].map((call) => format(...call.arguments));
}

/** The decisions_call log lines among `lines`, parsed. */
export function callLogs(lines: string[]): Record<string, unknown>[] {
  return lines
    .filter((line) => line.includes('"event":"decisions_call"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
