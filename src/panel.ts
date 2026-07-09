import * as vscode from "vscode";
import { SpeedStore } from "./store";
import {
  fmtCost,
  fmtEffort,
  fmtInt,
  fmtTime,
  fmtTimestamp,
  fmtTokPerSec,
  fmtWhen,
  isFastModeOn,
} from "./format";
import { CostWindows, Turn, TurnView, viewOf } from "./types";

/**
 * The stats tab opened by clicking the bolt. Opens in the active editor group,
 * reuses the existing tab if already open, and toggles closed on a second click.
 */
// While the panel is open, re-render on this cadence so the header's relative
// "(x ago)" hint advances; scripts are disabled in the webview, so the extension
// drives the refresh rather than client-side JS.
const REFRESH_MS = 10_000;

export class StatsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: SpeedStore,
    private readonly onVisibilityChange: (visible: boolean) => void
  ) {
    this.store.on("update", () => {
      if (this.panel) this.panel.webview.html = this.render();
    });
  }

  /** Click handler: open (in the current group) if closed, else close. */
  toggle(): void {
    if (this.panel) {
      this.panel.dispose();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "claudeSpeedometer.stats",
      "Claude Speedometer",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: false, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.render();
    this.onVisibilityChange(true);
    this.timer = setInterval(() => {
      if (this.panel) this.panel.webview.html = this.render();
    }, REFRESH_MS);
    this.panel.onDidDispose(() => {
      this.stopTimer();
      this.panel = undefined;
      this.onVisibilityChange(false);
    });
  }

  dispose(): void {
    this.stopTimer();
    this.panel?.dispose();
    this.panel = undefined;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private render(): string {
    const now = Date.now();
    const latest = this.store.getLatest();
    const recent = this.store.getRecent(20);
    const cost = this.store.getCostWindows(now);
    const body = latest
      ? this.renderTurn(viewOf(latest, now), recent, now, cost)
      : this.renderEmpty();
    return wrapHtml(body);
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
        return `<tr>
          <td>${fmtTimestamp(rv.lastMs)}</td>
          <td>${escapeHtml(session)}</td>
          <td title="${escapeHtml(model)}">${escapeHtml(model)}</td>
          <td class="num">${fmtInt(rv.inputTokens)}</td>
          <td class="num">${fmtInt(rv.outputTokens)}</td>
          <td class="num">${fmtTokPerSec(rv.totalTokPerSec)}</td>
        </tr>`;
      })
      .join("");

    return `
      <div class="head">
        <span class="title">Latest interaction</span>
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
        ["Input Tokens", fmtInt(v.inputTokens)],
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
      <h3>Cost (estimated)</h3>
      ${kv([
        ["Current Interaction", fmtCost(v.costUsd)],
        ["Today", fmtCost(cost.today)],
        ["This Week", fmtCost(cost.week)],
        ["This Month", fmtCost(cost.month)],
      ])}

      <hr />
      <h3>Model</h3>
      ${kv([
        ["Model", v.model ?? "-"],
        // Effort row appears only when the model reports an effort setting;
        // models that don't support effort configuration omit the attribute.
        ...(v.effort
          ? [["Effort", fmtEffort(v.effort)] as [string, string]]
          : []),
        // Fast mode row appears only when the model supports it and it is on.
        ...(isFastModeOn(v.speed)
          ? [["Fast Mode", "On"] as [string, string]]
          : []),
      ])}

      <hr />
      <h3>Workspace</h3>
      ${kv([
        ["Session", v.sessionId ? v.sessionId.slice(0, 8) : "-"],
        v.workspace
          ? ["Directory", ellipsizeLeft(v.workspace, 48), v.workspace]
          : ["Directory", "-"],
      ])}

      <hr />
      <h3>Recent interactions</h3>
      <table class="recent">
        <colgroup>
          <col style="width:24%" />
          <col style="width:12%" />
          <col style="width:20%" />
          <col style="width:15%" />
          <col style="width:15%" />
          <col style="width:14%" />
        </colgroup>
        <thead><tr>
          <th>When</th>
          <th>Session</th>
          <th>Model</th>
          <th class="num">Input</th>
          <th class="num">Output</th>
          <th class="num">Speed</th>
        </tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
      <p class="muted note">Each row aggregates all API calls (including tool
      steps) of one prompt. Output tokens include both thinking and visible text
      (the API does not separate them), and Speed (tok/s) is output over summed
      per-request time. Stats are global across all Claude Code sessions (each
      tracked separately, so concurrent sessions don't cut each other's turns
      short), not filtered to this VS Code window. Cost totals (Today, This Week
      from Monday, This Month) are estimates bucketed by UTC day (interaction
      times above are shown in local time) and accrue only from when telemetry
      was enabled.</p>`;
  }
}

function kv(rows: Array<[string, string] | [string, string, string]>): string {
  return `<div class="kv">${rows
    .map(([k, val, title]) => {
      const t = title ? ` title="${escapeHtml(title)}"` : "";
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wrapHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px 16px;
    max-width: 680px;
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
  .note { margin-top: 12px; }
  .empty { text-align: center; padding: 28px 8px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>${body}</body>
</html>`;
}
