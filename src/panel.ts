import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { BillingService } from "./billing";
import { SpeedStore } from "./store";
import {
  fmtCostWindow,
  fmtEffort,
  fmtEndpoint,
  fmtInt,
  fmtIntCompact,
  fmtModel,
  fmtPricedCost,
  fmtTime,
  fmtTimestamp,
  fmtTimestampShort,
  fmtTokPerSec,
  fmtWhen,
  isFastModeOn,
} from "./format";
import { CostWindow, CostWindows, Turn, TurnView, viewOf } from "./types";

/**
 * The stats tab opened by clicking the bolt. Opens in the active editor group,
 * reuses the existing tab if already open, and toggles closed on a second click.
 */
// While the panel is open, redraw on this cadence so the header's relative
// "(x ago)" hint advances. A redraw that changes nothing sends nothing.
const REFRESH_MS = 10_000;

// Longest workspace path the Workspace section prints before ellipsizing from
// the left. Budgeted against the body's 672px content box: the key column
// collapses to the word "Directory" (~63px) plus the grid's 16px gap, leaving
// ~590px, which at the ~6.5px a lowercase path averages per character holds
// well past 80.
const DIR_MAX_LEN = 80;

export class StatsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  // The body the page last received, so a redraw that changes nothing sends
  // nothing.
  private shown: string | undefined;

  constructor(
    private readonly store: SpeedStore,
    private readonly billing: BillingService,
    private readonly extensionUri: vscode.Uri,
    private readonly onVisibilityChange: (visible: boolean) => void
  ) {
    this.store.on("update", () => this.redraw());
  }

  /** Click handler: open (in the current group) if closed, else close. */
  toggle(): void {
    if (this.panel) {
      this.panel.dispose();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "claudeSpeedometer.stats",
      "Claude Code Speedometer",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    // The tab shows the extension's logo, the same icon.png its listing uses.
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "icon.png");
    // The page asks for the current body each time it loads. A reload by VS
    // Code rewrites the page from the html assigned below, which would
    // otherwise show that first render until the next change.
    this.panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === "ready") this.redraw(true);
    });
    // Every body carries the hover delay, so a changed one reaches the page
    // with a redraw.
    const config = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("workbench.hover.delay")) this.redraw(true);
    });
    this.shown = this.renderBody();
    this.panel.webview.html = wrapHtml(this.shown, newNonce(), hoverDelay());
    this.onVisibilityChange(true);
    this.timer = setInterval(() => this.redraw(), REFRESH_MS);
    this.panel.onDidDispose(() => {
      config.dispose();
      this.stopTimer();
      this.panel = undefined;
      this.shown = undefined;
      this.onVisibilityChange(false);
    });
  }

  dispose(): void {
    this.stopTimer();
    this.panel?.dispose();
    this.panel = undefined;
  }

  /** Redraw outside the usual triggers, for a change (an edited price table)
   *  that alters what is rendered without altering the shared state. */
  refresh(): void {
    this.redraw();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Send the current body to the page, which patches it into what is showing.
   * Assigning `webview.html` instead would have VS Code build a fresh iframe
   * and discard the old one, taking down a tooltip that is showing or waiting
   * out its delay, and the new page shows none until the pointer moves again.
   */
  private redraw(force = false): void {
    if (!this.panel) return;
    const body = this.renderBody();
    if (!force && body === this.shown) return;
    this.shown = body;
    void this.panel.webview.postMessage({
      type: "body",
      html: body,
      hoverDelay: hoverDelay(),
    });
  }

  private renderBody(): string {
    const now = Date.now();
    const latest = this.store.getLatest();
    const recent = this.store.getRecent(20);
    const cost = this.store.getCostWindows(now);
    const prices = this.billing.prices();
    return latest
      ? this.renderTurn(viewOf(latest, now, prices), recent, now, cost)
      : this.renderEmpty();
  }

  private renderEmpty(): string {
    return `
      <div class="empty">
        <p>No interactions captured yet.</p>
        <p class="muted">Once Claude Code finishes a request, its throughput and
        timing will appear here. If nothing shows up after a request, run
        <code>Claude Speedometer: Configure Claude Code Telemetry</code> from the
        Command Palette, then restart Claude Code.</p>
      </div>`;
  }

  private renderTurn(
    v: TurnView,
    recent: Turn[],
    now: number,
    cost: CostWindows
  ): string {
    const recentRows = recent
      .map((t) => {
        const rv = viewOf(t, now);
        const session = rv.sessionId ? rv.sessionId.slice(0, 8) : "-";
        const model = rv.model ?? "-";
        // Model column reads e.g. "opus-4-8 | max": the shortened id (see
        // fmtModel) plus the lowercased effort level. The tooltip keeps the
        // full id.
        const modelShort = fmtModel(rv.model);
        const effort = rv.effort ? rv.effort.toLowerCase() : "";
        const modelCell = effort ? `${modelShort} | ${effort}` : modelShort;
        const modelTip = effort ? `${model} | ${effort}` : model;
        // Workspace column shows just the innermost folder ("claude-speedometer"),
        // the part that identifies the project; the full path is the tooltip.
        // It falls back to "-" for turns whose transcript could not be read, and
        // for history recorded before paths were resolved.
        const workspace = rv.workspace;
        const workspaceCell = workspace ? leafDir(workspace) : "-";
        const workspaceTip = workspace ? tip(workspace) : "";
        // Input column reads e.g. "4.25M": every request's whole prompt,
        // summed and rounded (see fmtIntCompact). The tooltip has the exact
        // count and its split between the cache and the uncached remainder.
        const inputCell = fmtIntCompact(rv.totalInputTokens);
        const inputTip = inputBreakdown(rv);
        return `<tr>
          <td${tip(fmtTimestamp(rv.lastMs))}>${fmtTimestampShort(rv.lastMs)}</td>
          <td${workspaceTip}>${escapeHtml(workspaceCell)}</td>
          <td>${escapeHtml(session)}</td>
          <td${tip(modelTip)}>${escapeHtml(modelCell)}</td>
          <td class="num"${tip(inputTip)}>${inputCell}</td>
          <td class="num">${fmtInt(rv.outputTokens)}</td>
          <td class="num">${fmtTokPerSec(rv.totalTokPerSec)} <span class="unit">tok/s</span></td>
        </tr>`;
      })
      .join("");

    return `
      <div class="head">
        <span class="title">Latest Interaction</span>
        <span class="muted">${fmtWhen(v.lastMs, now)}</span>
      </div>

      <div class="hero">
        <span class="hero-num">${fmtTokPerSec(v.totalTokPerSec)}</span>
        <span class="hero-unit">tok/s</span>
      </div>

      <div class="hero-sub">Output Tokens (Thinking + Text) / Total Request Time</div>

      <hr />
      <h3>Tokens</h3>
      ${kv([
        ["Uncached Input Tokens", fmtInt(v.inputTokens)],
        ["Output Tokens (Thinking + Text)", fmtInt(v.outputTokens)],
        ["Cache Write Tokens", fmtInt(v.cacheCreationTokens)],
        ["Cache Read Tokens", fmtInt(v.cacheReadTokens)],
      ])}

      <hr />
      <h3>Timing</h3>
      ${kv([
        ["Total Request Time", fmtTime(v.totalMs)],
        ["Output Tokens / Second", `${fmtTokPerSec(v.totalTokPerSec)} tok/s`],
        ["API Requests", String(v.requests)],
      ])}

      <hr />
      <h3>Cost (estimated, UTC-bucketed)</h3>
      ${kv([
        latestCostRow(v),
        windowRow("Today", cost.today),
        windowRow("This Week", cost.week),
        windowRow("This Month", cost.month),
        windowRow("Last Month", cost.lastMonth),
      ])}

      <hr />
      <h3>Model</h3>
      ${kv([
        // The full id, which the shortened form drops a namespace from, is the
        // tooltip.
        ["Model", fmtModel(v.model), v.model ?? "-"],
        // Endpoint row appears only for a turn Claude Code could not price
        // itself, where which endpoint served it is what decides the figure
        // above. A first-party turn has nothing to disambiguate.
        ...(v.costBasis === "local" ? [endpointRow(v)] : []),
        // Effort row appears only when the model reports an effort setting;
        // models that don't support effort configuration omit the attribute.
        ...(v.effort
          ? [["Effort", fmtEffort(v.effort)] as [string, string]]
          : []),
        // Fast Mode row appears only when the model supports it and it is on.
        ...(isFastModeOn(v.speed)
          ? [["Fast Mode", "On"] as [string, string]]
          : []),
      ])}

      <hr />
      <h3>Workspace</h3>
      ${kv([
        ["Session", v.sessionId ? v.sessionId.slice(0, 8) : "-"],
        v.workspace
          ? ["Directory", ellipsizeLeft(v.workspace, DIR_MAX_LEN), v.workspace]
          : ["Directory", "-"],
      ])}

      <hr />
      <h3>Recent interactions</h3>
      <table class="recent">
        <colgroup>
          <!-- Width budget, in percent of the table (the body's max width, less
               ~12px when a scrollbar is present). Every column is its worst-case
               content plus one shared 12px gutter (the cells' padding-right), so
               the columns sit as close together as their contents allow and a
               full row's gaps are even. Worst cases, measured at this table's
               12px type: the year-less "MM-DD HH:MM:SS" stamp, a 22-character
               folder name, an 8-char session, a "haiku-4-5 | medium"-shaped
               model cell, a seven-digit output count ("9,999,999", well past
               what one interaction reaches), and a speed below 1000
               ("999.99 tok/s"). The input count, a sum of every request's whole
               prompt, reaches eight digits, so it is rounded to three
               significant figures ("28.4M") and shares the output column's
               width. The two variable-length cells run over on their rare long
               values, ellipsizing in CSS with the full text on hover: a dated
               model id ("haiku-4-5-20251001 | medium") and an unusually long
               folder name. -->
          <col style="width:15.5%" />
          <col style="width:23.5%" />
          <col style="width:11%" />
          <col style="width:17.75%" />
          <col style="width:10.75%" />
          <col style="width:10.75%" />
          <col style="width:10.75%" />
        </colgroup>
        <thead><tr>
          <th>When (Local)</th>
          <th>Workspace</th>
          <th>Session</th>
          <th>Model | Effort</th>
          <th class="num">Input</th>
          <th class="num">Output</th>
          <th class="num">Speed</th>
        </tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
      <p class="muted note">Each row is one prompt's API calls to one model, so
      a helper call on another model, such as the Haiku call that names a
      session, gets its own row. Input adds up the prompt each of those
      calls sent, cache reads and writes included, with the breakdown on
      hover. Stats span all Claude Code sessions, not just this window. Cost
      totals accrue from when telemetry was enabled, and weeks start on
      Monday. Interactions Claude Code cannot price are costed from
      configured rates. One with no rate reads "unpriced", and any total that
      includes it is marked \u2265.</p>`;
  }
}

type KvRow = [string, string] | [string, string, string];

const UNRESOLVED_ENDPOINT_TITLE =
  "Claude Code's base URL could not be read from any settings file, from a " +
  "BYOK record, from a provider extension in any open window, or from this " +
  "window's environment. Add a claudeSpeedometer.providers entry with no " +
  "endpoint to price these interactions.";

const LOWER_BOUND_TITLE =
  "Lower bound: this window contains interactions that have never had a " +
  "configured rate, which contribute nothing to the total.";

/** The latest turn's cost, with hover text saying where the number came from
 *  (or why there is none), so a recomputed, remembered or missing figure
 *  explains itself. */
function latestCostRow(v: TurnView): KvRow {
  const label = "Latest Interaction";
  const value = fmtPricedCost(v.cost);
  const where = v.endpoint ? fmtEndpoint(v.endpoint) : "an unresolved endpoint";
  if (v.cost.state === "recomputed") {
    return [
      label,
      value,
      `Recomputed from the rate that claudeSpeedometer.providers, a BYOK ` +
        `record or a provider extension declares for ` +
        `${v.model ?? "this model"} at ${where}. Claude Code's own figure ` +
        `assumes Anthropic's rates (its default model's, for a model it does ` +
        `not recognize), so it is discarded.`,
    ];
  }
  if (v.cost.state === "remembered") {
    return [
      label,
      value,
      `Priced at the rate that last applied to ${v.model ?? "this model"} ` +
        `at ${where}. No current rate is readable, as when the tool that ` +
        `wrote a BYOK record has exited or the window whose provider ` +
        `extension supplied the rate has closed.`,
    ];
  }
  if (v.cost.state === "unpriced") {
    return [
      label,
      value,
      `No rate configured for ${v.model ?? "this model"} at ${where}, and ` +
        `Claude Code's own figure is a guess at Anthropic's rate rather than ` +
        `what this interaction cost. Note the id above is the one the response ` +
        `reported, which a gateway can resolve away from the one you asked ` +
        `for; list it under reportedAs if so.`,
    ];
  }
  return [label, value];
}

function windowRow(label: string, w: CostWindow): KvRow {
  const value = fmtCostWindow(w);
  return w.lowerBound ? [label, value, LOWER_BOUND_TITLE] : [label, value];
}

/** The base URL, hovering to the full form the display drops the scheme from,
 *  or to an explanation when there was none to resolve. */
function endpointRow(v: TurnView): KvRow {
  const title = v.endpoint ?? UNRESOLVED_ENDPOINT_TITLE;
  return ["Endpoint", fmtEndpoint(v.endpoint), title];
}

/** Hover text for a Recent row's Input cell: the exact count behind the
 *  rounded figure, then how it splits between the cache and the uncached
 *  remainder, one part per line. */
function inputBreakdown(v: TurnView): string {
  const requests = v.requests === 1 ? "1 request" : `${v.requests} requests`;
  return [
    `${fmtInt(v.totalInputTokens)} input tokens across ${requests}:`,
    `${fmtInt(v.cacheReadTokens)} cache read`,
    `${fmtInt(v.cacheCreationTokens)} cache write`,
    `${fmtInt(v.inputTokens)} uncached`,
  ].join("\n");
}

function kv(rows: KvRow[]): string {
  return `<div class="kv">${rows
    .map(([k, val, title]) => {
      const t = title ? tip(title) : "";
      return `<div class="k">${escapeHtml(k)}</div><div class="v"${t}>${escapeHtml(
        val
      )}</div>`;
    })
    .join("")}</div>`;
}

/** Truncate from the left, keeping the right-most portion, prefixed with "…".
 *  Used for long workspace paths so the most specific folder stays visible. */
function ellipsizeLeft(s: string, max: number): string {
  if (s.length <= max) return s;
  return "…" + s.slice(-(max - 1));
}

/** The innermost folder of a workspace path ("~/apps/my-project" -> "my-project"),
 *  which is what identifies the project at a glance. Splits on both separators so
 *  a Windows path resolves too, and falls back to the whole string if the path has
 *  no named segment (e.g. "/"). */
function leafDir(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Attributes giving an element the page's own tooltip. The same text is its
 *  accessible description, the part of a native title that assistive tech
 *  reads. */
function tip(text: string): string {
  const t = escapeHtml(text);
  return ` data-tip="${t}" aria-description="${t}"`;
}

/** VS Code's delay before its own hovers appear, which the status bar's uses,
 *  so the page's tooltips keep the same time. */
function hoverDelay(): number {
  return vscode.workspace
    .getConfiguration("workbench.hover")
    .get<number>("delay", 500);
}

/** A fresh nonce for the page's one script, which the CSP admits by it. */
function newNonce(): string {
  return randomBytes(16).toString("hex");
}

// The page's one script, which does two things.
//
// It patches each body the extension sends into the live page: a node is kept
// wherever the new markup has one of the same kind at the same position, and
// only text and attributes that differ are rewritten, so the cell under the
// pointer stays the same element through a redraw. Only #content is patched,
// leaving the tooltip, this script, and the body's own attributes (where VS
// Code stamps its theme and role) as they are.
//
// It draws the tooltips itself rather than leaving them to native titles,
// whose timing on macOS the page cannot control: Chromium restarts the
// system's tooltip delay whenever the pointer crosses onto another node, the
// edge of a cell's text included, and by default drops the tooltip while the
// window is not key. Like VS Code's own hovers, a tooltip here appears the
// hover delay after the pointer reaches an element with one, however it then
// moves within it, and at once when reached within INSTANT_MS of the last one
// hiding, so running down a column reads each value without waiting again.
const PAGE_SCRIPT = `(() => {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById("content");
  const tip = document.getElementById("tip");
  const INSTANT_MS = 200;
  let delay = Number(tip.dataset.delay) || 0;
  let target = null;
  let timer = 0;
  let hiddenAt = -Infinity;

  function patch(live, next) {
    if (live.nodeType !== Node.ELEMENT_NODE) {
      if (live.nodeValue !== next.nodeValue) live.nodeValue = next.nodeValue;
      return;
    }
    for (const { name } of Array.from(live.attributes)) {
      if (!next.hasAttribute(name)) live.removeAttribute(name);
    }
    for (const { name, value } of Array.from(next.attributes)) {
      if (live.getAttribute(name) !== value) live.setAttribute(name, value);
    }
    patchChildren(live, next);
  }
  function patchChildren(live, next) {
    const have = Array.from(live.childNodes);
    const want = Array.from(next.childNodes);
    want.forEach((node, i) => {
      const old = have[i];
      if (!old) live.appendChild(node);
      else if (old.nodeType !== node.nodeType || old.nodeName !== node.nodeName)
        live.replaceChild(node, old);
      else patch(old, node);
    });
    for (const old of have.slice(want.length)) old.remove();
  }

  function show(fade) {
    timer = 0;
    if (!target || !target.isConnected || !target.dataset.tip) return hide();
    tip.textContent = target.dataset.tip;
    tip.classList.toggle("fade", fade);
    tip.classList.add("shown");
    place();
  }
  // Below the element, or above it when only that fits, kept inside the page.
  function place() {
    const r = target.getBoundingClientRect();
    const page = document.documentElement;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const below = r.bottom + 4;
    const above = r.top - h - 4;
    const fits = below + h <= page.clientHeight - 8 || above < 8;
    tip.style.left = Math.max(8, Math.min(r.left, page.clientWidth - w - 8)) + "px";
    tip.style.top = (fits ? below : above) + "px";
  }
  function hide() {
    clearTimeout(timer);
    timer = 0;
    target = null;
    if (!tip.classList.contains("shown")) return;
    tip.classList.remove("shown");
    hiddenAt = performance.now();
  }
  document.addEventListener("mouseover", (e) => {
    const el = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    if (performance.now() - hiddenAt < INSTANT_MS) show(false);
    else timer = setTimeout(show, delay, true);
  });
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) hide();
  });
  document.addEventListener("mousedown", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  window.addEventListener("scroll", () => {
    if (tip.classList.contains("shown")) place();
  }, true);

  window.addEventListener("message", (e) => {
    if (e.data?.type !== "body") return;
    if (typeof e.data.hoverDelay === "number") delay = e.data.hoverDelay;
    // Opened explicitly, the body keeps the leading whitespace that the live
    // page has, which a bare fragment would lose, shifting every position.
    const html = "<body>" + e.data.html;
    const next = new DOMParser().parseFromString(html, "text/html");
    patchChildren(content, next.body);
    // The element under the pointer kept its identity, but maybe not its value.
    if (!target) return;
    if (!target.isConnected || !target.dataset.tip) hide();
    else if (tip.classList.contains("shown")) show(false);
  });
  vscode.postMessage({ type: "ready" });
})();`;

function wrapHtml(body: string, nonce: string, delayMs: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px 16px;
    /* The Recent table's seven columns at their worst-case content plus a 12px
       gutter each, which is what sets the panel's width: sized any wider, the
       table's fixed columns would stretch and reintroduce the dead space
       between them. */
    max-width: 672px;
  }
  hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    margin: 14px 0;
  }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 8px 0;
  }
  .head { display: flex; align-items: center; gap: 8px; }
  .title { font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .hero { margin: 12px 0 2px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .hero-num { font-size: 34px; font-weight: 700; line-height: 1; }
  .hero-unit { font-size: 14px; color: var(--vscode-descriptionForeground); }
  .hero-sub { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 2px; }
  .kv { display: grid; grid-template-columns: 1fr auto; row-gap: 5px; column-gap: 16px; }
  .kv .k { color: var(--vscode-descriptionForeground); }
  .kv .v { text-align: right; font-variant-numeric: tabular-nums; }
  table.recent { width: 100%; border-collapse: collapse; table-layout: fixed; font-variant-numeric: tabular-nums; font-size: 12px; }
  table.recent th { font-weight: 500; color: var(--vscode-descriptionForeground); text-align: left; }
  table.recent th, table.recent td { padding: 2px 0; }
  table.recent th:not(:last-child), table.recent td:not(:last-child) { padding-right: 12px; }
  table.recent th.num, table.recent td.num { text-align: right; }
  table.recent td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  table.recent .unit { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .note { margin-top: 12px; }
  .empty { text-align: center; padding: 28px 8px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  /* Drawn like VS Code's own compact hovers (the status bar's among them). Its
     shadow token is not passed to webviews, so its value is spelled out. */
  #tip {
    position: fixed;
    z-index: 40;
    display: none;
    box-sizing: border-box;
    max-width: min(700px, calc(100vw - 16px));
    padding: 2px 8px;
    font-size: 12px;
    line-height: 19px;
    white-space: pre-line;
    overflow-wrap: anywhere;
    color: var(--vscode-editorHoverWidget-foreground);
    background: var(--vscode-editorHoverWidget-background);
    border: 1px solid var(--vscode-editorHoverWidget-border);
    border-radius: 5px;
    box-shadow: 0 0 12px rgba(0, 0, 0, 0.14);
    pointer-events: none;
  }
  #tip.shown { display: block; }
  #tip.fade { animation: tip-fade 0.1s linear; }
  .vscode-reduce-motion #tip.fade { animation: none; }
  @keyframes tip-fade { from { opacity: 0; } }
</style>
</head>
<body><div id="content">${body}</div><div id="tip" aria-hidden="true" data-delay="${delayMs}"></div><script nonce="${nonce}">${PAGE_SCRIPT}</script></body></html>`;
}
