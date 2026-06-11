import * as vscode from "vscode";
import { SpeedStore } from "./store";
import {
  fmtAgo,
  fmtCost,
  fmtFastMode,
  fmtInt,
  fmtTime,
  fmtTokPerSec,
} from "./format";
import { Turn, TurnView, viewOf } from "./types";

/**
 * The stats tab opened by clicking the bolt. Opens in the active editor group,
 * reuses the existing tab if already open, and toggles closed on a second click.
 */
export class StatsPanel {
  private panel: vscode.WebviewPanel | undefined;

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
      "claudeCodeSpeed.stats",
      "Claude Code Speed",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: false, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.render();
    this.onVisibilityChange(true);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.onVisibilityChange(false);
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private render(): string {
    const now = Date.now();
    const latest = this.store.getLatest();
    const recent = this.store.getRecent(8);
    const body = latest
      ? this.renderTurn(viewOf(latest, now), recent, now)
      : this.renderEmpty();
    return wrapHtml(body);
  }

  private renderEmpty(): string {
    return `
      <div class="empty">
        <p>No interactions captured yet.</p>
        <p class="muted">Once Claude Code finishes a request, its throughput and
        timing will appear here. If nothing shows up after a request, run
        <code>Claude Code Speed: Configure Claude Code Telemetry</code> from the
        Command Palette, then restart Claude Code.</p>
      </div>`;
  }

  private renderTurn(v: TurnView, recent: Turn[], now: number): string {
    const recentRows = recent
      .map((t) => {
        const rv = viewOf(t, now);
        return `<tr>
          <td>${fmtAgo(rv.ageMs)}</td>
          <td class="num">${fmtInt(rv.outputTokens)}</td>
          <td class="num">${fmtTokPerSec(rv.totalTokPerSec)}</td>
          <td class="num">${fmtTime(rv.totalMs)}</td>
        </tr>`;
      })
      .join("");

    return `
      <div class="head">
        <span class="title">Latest interaction</span>
        <span class="muted">${fmtAgo(v.ageMs)}</span>
      </div>

      <div class="hero">
        <span class="hero-num">${fmtTokPerSec(v.totalTokPerSec)}</span>
        <span class="hero-unit">tok/sec</span>
        <span class="muted">(generation: ${fmtTokPerSec(
          v.generationTokPerSec
        )} tok/sec)</span>
      </div>

      <hr />
      <h3>Tokens</h3>
      ${kv([
        ["Text Input Tokens", fmtInt(v.inputTokens)],
        ["Text Output Tokens", fmtInt(v.outputTokens)],
        ["Cache Write Tokens", fmtInt(v.cacheCreationTokens)],
        ["Cache Read Tokens", fmtInt(v.cacheReadTokens)],
      ])}

      <hr />
      <h3>Timing</h3>
      ${kv([
        ["Time to First Token", fmtTime(v.ttftMs)],
        ["Generation Time", fmtTime(v.generationMs)],
        ["Total Time", fmtTime(v.totalMs)],
        ["Output Tokens / sec", `${fmtTokPerSec(v.totalTokPerSec)} t/s`],
        ["API Requests", String(v.requests)],
      ])}

      <hr />
      <h3>Cost &amp; Model</h3>
      ${kv([
        ["Estimated Cost", fmtCost(v.costUsd)],
        ["Model", v.model ?? "-"],
        ["Fast mode", fmtFastMode(v.speed)],
      ])}

      <hr />
      <h3>Context</h3>
      ${kv([
        ["Session", v.sessionId ? v.sessionId.slice(0, 8) : "-"],
        ["Terminal", v.terminalType ?? "-"],
      ])}

      <hr />
      <h3>Recent interactions</h3>
      <table class="recent">
        <colgroup>
          <col style="width:34%" />
          <col style="width:22%" />
          <col style="width:22%" />
          <col style="width:22%" />
        </colgroup>
        <thead><tr><th>When</th><th class="num">Output</th><th class="num">tok/sec</th><th class="num">Total</th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
      <p class="muted note">Each row aggregates all API calls (including tool
      steps) of one prompt. Stats are global across Claude Code sessions, not
      filtered to this workspace.</p>`;
  }
}

function kv(rows: Array<[string, string]>): string {
  return `<div class="kv">${rows
    .map(
      ([k, val]) =>
        `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(
          val
        )}</div>`
    )
    .join("")}</div>`;
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
    max-width: 460px;
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
  .kv { display: grid; grid-template-columns: 1fr auto; row-gap: 5px; column-gap: 16px; }
  .kv .k { color: var(--vscode-descriptionForeground); }
  .kv .v { text-align: right; font-variant-numeric: tabular-nums; }
  table.recent { width: 100%; border-collapse: collapse; table-layout: fixed; font-variant-numeric: tabular-nums; }
  table.recent th { font-weight: 500; color: var(--vscode-descriptionForeground); padding: 2px 0; font-size: 12px; text-align: left; }
  table.recent th.num, table.recent td.num { text-align: right; }
  table.recent td { padding: 2px 0; }
  .note { margin-top: 12px; }
  .empty { text-align: center; padding: 28px 8px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>${body}</body>
</html>`;
}
