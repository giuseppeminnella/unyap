import type { Analysis, AnalysisProgress } from "../../../shared/types.ts";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** A persistent DOM tree keeps progress transitions smooth even when both API calls finish quickly. */
export class DebugOverlay {
  readonly element = node("section", "unyap-debug");
  private readonly status = node("span", "unyap-debug-status", "CONNECTING");
  private readonly model = node("p", "unyap-debug-model", "Waiting for the analysis…");
  private readonly log = node("ol", "unyap-debug-log");
  private readonly count = node("strong", "unyap-debug-count", "—");
  private readonly caption = node("span", "unyap-debug-caption", "Judgments processed");
  private readonly bar = node("div", "unyap-debug-progress");
  private readonly fill = node("div", "unyap-debug-progress-fill");
  private readonly detail = node("p", "unyap-debug-detail", "Many judgments are batched into each API request.");
  private readonly calls = new Set<"main" | "refine">();
  private readonly ended = new Set<"main" | "refine">();
  private firstAt: number | null = null;
  private planned = 0;
  private answered = 0;
  private refineFallback = false;
  private mock = false;
  private done = false;

  constructor() {
    this.element.setAttribute("aria-label", "Unyap debug mode");
    this.element.dataset.state = "running";
    const header = node("div", "unyap-debug-header");
    header.append(node("strong", "unyap-debug-brand", "UNYAP / DEBUG"), this.status);
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-label", "Analysis activity");
    this.log.tabIndex = 0;
    const work = node("div", "unyap-debug-work");
    const numbers = node("div", "unyap-debug-numbers");
    numbers.append(this.count, this.caption);
    this.bar.setAttribute("role", "progressbar");
    this.bar.setAttribute("aria-label", "Analysis progress");
    this.bar.setAttribute("aria-valuemin", "0");
    this.bar.setAttribute("aria-valuemax", "100");
    this.bar.append(this.fill);
    work.append(numbers, this.bar, this.detail);
    this.element.append(header, this.model, this.log, work);
  }

  private entry(title: string, detail: string, atMs?: number, error = false): void {
    const row = node("li", "unyap-debug-entry");
    if (error) row.dataset.error = "true";
    const elapsed = atMs === undefined || this.firstAt === null ? "•" : `+${((atMs - this.firstAt) / 1000).toFixed(2)}s`;
    row.append(node("span", "unyap-debug-time", elapsed), node("strong", "unyap-debug-title", title));
    if (detail) row.append(node("p", "unyap-debug-description", detail));
    this.log.append(row);
    this.log.scrollTop = this.log.scrollHeight;
  }

  progress(event: AnalysisProgress): void {
    this.firstAt ??= event.atMs;
    switch (event.type) {
      case "prepared":
        this.planned = event.plannedQuestions;
        this.status.textContent = "ANALYZING";
        this.entry(`${event.segments} segments prepared`, "1 predicate + 1 payoff choice + a score per segment", event.atMs);
        break;
      case "call-start":
        this.calls.add(event.call);
        this.mock = event.mode === "mock";
        this.model.textContent = this.mock ? "Mock mode · no OpenAI requests" : `${event.model} · /v1/decisions`;
        this.status.textContent = event.call === "main" ? "SCORING" : "REFINING";
        this.entry(`${this.mock ? "Mock" : "POST"} · ${event.call === "main" ? "Main request" : "Refine payoff"}`,
          `${event.questions} ${event.questions === 1 ? "question" : "questions"} · ${event.choices} ` +
          `${event.call === "main" ? "payoff choices" : "transcript lines"}`, event.atMs);
        break;
      case "call-end":
        this.refineFallback ||= event.call === "refine" && event.refusals > 0;
        if (!this.ended.has(event.call)) this.answered += event.questions;
        this.ended.add(event.call);
        this.entry(`${event.call === "main" ? "Main" : "Refinement"} response · ${event.latencyMs} ms`,
          `${event.questions} ${event.questions === 1 ? "reply" : "replies"} · ` +
          `${event.inputTokens} input tokens (${event.cachedTokens} cached)` +
          (event.refusals ? ` · ${event.refusals} ${event.refusals === 1 ? "refusal" : "refusals"}` : ""), event.atMs);
        break;
      case "call-error":
        this.refineFallback ||= event.call === "refine";
        this.entry(`${event.call === "main" ? "Main" : "Refinement"} request failed`, event.error, event.atMs, true);
        break;
      case "refine-skipped":
        this.planned = this.answered;
        this.entry("Refinement skipped", event.reason === "no-payoff" ? "No payoff to refine." : "Fewer than two nearby lines.",
          event.atMs);
        break;
    }
    this.count.textContent = String(this.answered);
    this.caption.textContent = this.planned ? `of up to ${this.planned} judgments` : "Judgments processed";
    this.updateBar();
  }

  finish(analysis: Analysis | null, error?: string): void {
    this.done = true;
    this.element.dataset.state = analysis ? "complete" : "error";
    this.status.textContent = analysis ? (analysis.cached ? "CACHED" : "READY") : "STOPPED";
    if (!analysis) {
      this.entry("Analysis stopped", error ?? "The analysis ended without a result.", undefined, true);
      this.caption.textContent = "Judgments received before stopping";
    } else if (analysis.cached) {
      this.entry("Cache hit", "Saved analysis reused. No Decisions API requests needed.");
      this.count.textContent = "0";
      this.caption.textContent = "API requests · cached analysis";
      this.model.textContent = "Cached analysis";
      this.detail.textContent = "The cache saves another round of model calls.";
    } else {
      this.caption.textContent = `judgments · ${this.calls.size} ` +
        (this.mock ? "mock calls" : `API ${this.calls.size === 1 ? "request" : "requests"}`);
      this.entry("Analysis ready", this.refineFallback ? "Using the coarse payoff because refinement was unavailable." :
        "The analysis is ready in the player.");
    }
    this.updateBar(Boolean(analysis));
  }

  private updateBar(complete = false): void {
    const percent = complete ? 100 : this.planned ? Math.min(99, this.answered / this.planned * 100) : 0;
    // Establish the previous width even when cached/mock replies arrive before the browser's next paint.
    this.fill.getBoundingClientRect();
    this.fill.style.width = `${percent}%`;
    if (this.planned || this.done) this.bar.setAttribute("aria-valuenow", String(Math.round(percent)));
    this.bar.setAttribute("aria-valuetext", `${this.count.textContent} ${this.caption.textContent}`);
  }
}
