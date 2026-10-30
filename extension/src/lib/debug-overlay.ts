import { formatTime } from "../../../shared/timeline.ts";
import type { Analysis, AnalysisProgress, CallAnswers, DecisionsQuestion } from "../../../shared/types.ts";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// The same "S1"-style names pipeline/decisions.ts gives segments and their scores; spelled out here so the content
// bundle stays free of the pipeline.
function segmentLabel(index: number): string {
  return `S${index + 1}`;
}

/** One labeled row inside an expanded request or response. */
function spec(name: string, text: string): HTMLElement {
  const row = node("div", "unyap-debug-q");
  row.append(node("strong", "unyap-debug-qname", name), node("p", "unyap-debug-qtext", text));
  return row;
}

function specList(items: string[]): HTMLElement {
  const list = node("ul", "unyap-debug-list");
  for (const item of items) list.append(node("li", "", item));
  return list;
}

type ScoreQuestion = Extract<DecisionsQuestion, { type: "score" }>;

/** The questions in words: predicate and choice verbatim, the per-segment score series as one grouped block. */
function requestBody(questions: DecisionsQuestion[]): HTMLElement {
  const body = node("div", "unyap-debug-spec");
  const scores = questions.filter((question): question is ScoreQuestion => question.type === "score");
  const first = scores[0];
  const scoresBlock = first === undefined ? null : (() => {
    const block = node("div", "unyap-debug-q");
    block.append(
      node("strong", "unyap-debug-qname", `Score · ${first.name} … ${scores.at(-1)?.name ?? first.name}`),
      node("p", "unyap-debug-qtext", `One per segment, ${scores.length} in total. The first reads: "${first.instructions}"`),
      specList(first.levels.map((level) => `${level.label} — ${level.description}`)),
    );
    return block;
  })();
  for (const question of questions) {
    if (question.type === "score") {
      // The whole series goes at the first score's position.
      if (question === first && scoresBlock) body.append(scoresBlock);
      continue;
    }
    const kind = question.type === "predicate" ? "Predicate" : "Choice";
    const block = node("div", "unyap-debug-q");
    block.append(node("strong", "unyap-debug-qname", `${kind} · ${question.name}`));
    block.append(node("p", "unyap-debug-qtext", question.instructions));
    if (question.type === "choice") {
      block.append(specList(question.choices.map((choice) => `${choice.value} — ${choice.description}`)));
    }
    body.append(block);
  }
  return body;
}

/** The main call's answers in words: delivers, the payoff choice and one row per segment. */
function mainAnswersBody(detail: Extract<CallAnswers, { call: "main" }>, refusals: string[]): HTMLElement {
  const body = node("div", "unyap-debug-spec");
  body.append(spec("delivers", refusals.includes("delivers")
    ? "refused — counted as 50%"
    : `${pct(detail.delivers)} likely to deliver what the title promises`));
  body.append(spec("payoff", refusals.includes("payoff")
    ? "refused — no payoff chosen"
    : detail.payoff === null
    ? '"none" — the promise is never delivered'
    : `${segmentLabel(detail.payoff.segmentIndex)} at ${formatTime(detail.payoff.startMs)} · ` +
      `${pct(detail.payoff.confidence)} confident`));
  const list = node("ul", "unyap-debug-list");
  for (const segment of detail.segments) {
    const name = segmentLabel(segment.index);
    const judged = refusals.includes(`substance_${name}`)
      ? "refused — counted as context 50%"
      : `${segment.level} · ${pct(segment.substance)}`;
    const item = node("li", "", `${name} · ${formatTime(segment.startMs)}–${formatTime(segment.endMs)} · ${judged}`);
    if (detail.payoff?.segmentIndex === segment.index) {
      item.dataset.payoff = "true";
      item.append("← payoff");
    }
    list.append(item);
  }
  body.append(list);
  return body;
}

/** The refinement's answer in words: the chosen line and whether it moved the payoff. */
function refineAnswersBody(detail: Extract<CallAnswers, { call: "refine" }>, coarseStartMs: number | null): HTMLElement {
  const body = node("div", "unyap-debug-spec");
  if (detail.startMs === null) {
    const kept = coarseStartMs === null ? "" : ` (${formatTime(coarseStartMs)})`;
    body.append(spec("start", `refused — the payoff stays at the segment start${kept}`));
    return body;
  }
  body.append(spec("start", `${detail.line ?? "?"} at ${formatTime(detail.startMs)}`));
  const moved = coarseStartMs !== null && detail.startMs !== coarseStartMs;
  body.append(node("p", "unyap-debug-qtext", moved
    ? `The payoff moves from the segment start (${formatTime(coarseStartMs)}) to this line.`
    : "The same as the segment start: the payoff does not move."));
  return body;
}

/** A persistent DOM tree keeps progress transitions smooth even when both API calls finish quickly. */
export class DebugOverlay {
  readonly element = node("section", "unyap-debug");
  private readonly minimizeButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly onClose: (() => void) | undefined;
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
  private minimized = false;
  private closed = false;
  private coarsePayoffStartMs: number | null = null;

  constructor(onClose?: () => void) {
    this.onClose = onClose;
    this.element.setAttribute("aria-label", "Unyap debug mode");
    this.element.dataset.state = "running";
    this.element.dataset.minimized = "false";

    this.minimizeButton = node("button", "unyap-debug-action", "−");
    this.minimizeButton.type = "button";
    this.minimizeButton.setAttribute("aria-label", "Minimize debug panel");
    this.minimizeButton.title = "Minimize";
    this.minimizeButton.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      this.toggleMinimized();
    });

    this.closeButton = node("button", "unyap-debug-action", "×");
    this.closeButton.type = "button";
    this.closeButton.setAttribute("aria-label", "Close debug panel");
    this.closeButton.title = "Close";
    this.closeButton.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      this.close();
    });

    const controls = node("div", "unyap-debug-controls");
    controls.append(this.minimizeButton, this.closeButton);
    const header = node("div", "unyap-debug-header");
    header.append(node("strong", "unyap-debug-brand", "UNYAP / DEBUG"), this.status, controls);
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

  private entry(title: string, detail: string, atMs?: number, error = false, expand?: { label: string; body: HTMLElement }): void {
    const row = node("li", "unyap-debug-entry");
    if (error) row.dataset.error = "true";
    const elapsed = atMs === undefined || this.firstAt === null ? "•" : `+${((atMs - this.firstAt) / 1000).toFixed(2)}s`;
    row.append(node("span", "unyap-debug-time", elapsed), node("strong", "unyap-debug-title", title));
    if (detail) row.append(node("p", "unyap-debug-description", detail));
    if (expand) {
      const details = node("details", "unyap-debug-expand");
      details.append(node("summary", "unyap-debug-toggle", expand.label), expand.body);
      row.append(details);
    }
    this.log.append(row);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private toggleMinimized(): void {
    this.minimized = !this.minimized;
    this.element.dataset.minimized = String(this.minimized);
    this.minimizeButton.textContent = this.minimized ? "+" : "−";
    this.minimizeButton.setAttribute(
      "aria-label",
      this.minimized ? "Expand debug panel" : "Minimize debug panel",
    );
    this.minimizeButton.title = this.minimized ? "Expand" : "Minimize";
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.element.remove();
    this.onClose?.();
  }

  progress(event: AnalysisProgress): void {
    if (this.closed) return;
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
        this.model.textContent = this.mock ? "Mock mode · no API requests" : `${event.model} · Decisions API`;
        this.status.textContent = event.call === "main" ? "SCORING" : "REFINING";
        this.entry(
          `${this.mock ? "Mock" : "POST"} · ${event.call === "main" ? "Main request" : "Refine payoff"}`,
          `${event.questions} ${event.questions === 1 ? "question" : "questions"} · ${event.choices} ` +
          `${event.call === "main" ? "payoff choices" : "transcript lines"}`,
          event.atMs,
          false,
          { label: "Request", body: requestBody(event.detail) },
        );
        break;
      case "call-end": {
        this.refineFallback ||= event.call === "refine" && event.refusals > 0;
        if (!this.ended.has(event.call)) this.answered += event.questions;
        this.ended.add(event.call);
        const answers = event.detail;
        let body: HTMLElement;
        if (answers.call === "main") {
          // Kept for the refinement's entry, which says whether its line moved the payoff.
          this.coarsePayoffStartMs = answers.payoff?.startMs ?? null;
          body = mainAnswersBody(answers, event.refusalNames);
        } else {
          body = refineAnswersBody(answers, this.coarsePayoffStartMs);
        }
        const refused = event.refusalNames.length > 0 ? ` · refused: ${event.refusalNames.join(", ")}` : "";
        this.entry(
          `${event.call === "main" ? "Main" : "Refinement"} response · ${event.latencyMs} ms`,
          `${event.questions} ${event.questions === 1 ? "reply" : "replies"} · ` +
          `${event.inputTokens} input tokens (${event.cachedTokens} cached)${refused}`,
          event.atMs,
          false,
          { label: "Response", body },
        );
        break;
      }
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
    if (this.closed) return;
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
