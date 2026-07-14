import * as vscode from "vscode";
import { SpeedStore } from "./store";
import {
  fmtCost,
  fmtEffort,
  fmtInt,
  fmtTime,
  fmtTokPerSec,
  fmtWhen,
  isFastModeOn,
} from "./format";
import { viewOf } from "./types";

type Row = [string, string];
interface Section {
  title: string;
  rows: Row[];
}

const GAP = "     "; // spacing between the label and value columns
const MIN_VALUE_WIDTH = 12; // keep the value column roomy even for small numbers
const MAX_VALUE_WIDTH = 14; // wider values (e.g. a dated model id) overflow their own row

/**
 * The overlay shown when hovering the bolt: a rich Markdown box that pops up just
 * above the status bar (lower-right). Sections render as monospace code blocks
 * sharing one column layout, so values align across every section.
 */
export function buildTooltip(store: SpeedStore): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  // A trusted MarkdownString that carries interactive command links makes VS Code
  // render the status-bar hover as an interactive popup: the cursor can move into
  // it and it lingers, instead of a passive tooltip that vanishes on mouse-out.
  // (The status-bar item also carries a `command`, which the hover requires to
  // fire; see microsoft/vscode#75909.) Without interactive content, no amount of
  // trust makes the hover sticky, so the action row near the end is what enables it.
  md.isTrusted = true;
  md.supportThemeIcons = true;
  const now = Date.now();

  const latest = store.getLatest();
  if (!latest) {
    md.appendMarkdown(
      "**Claude Speedometer**\n\nWaiting for the next Claude Code interaction…"
    );
    return md;
  }

  const v = viewOf(latest, now);
  const cw = store.getCostWindows(now);

  const L: string[] = [];
  L.push(`**Latest Interaction** · ${fmtWhen(v.lastMs, now)}`);
  L.push("");
  L.push(`## ${fmtTokPerSec(v.totalTokPerSec)} tok/s`);

  const sections: Section[] = [
    {
      title: "Model",
      rows: [
        ["Model", v.model ?? "-"],
        // Effort row appears only when the model reports an effort setting.
        ...(v.effort ? [["Effort", fmtEffort(v.effort)] as Row] : []),
        // Fast Mode row appears only when the model supports it and it is on.
        ...(isFastModeOn(v.speed) ? [["Fast Mode", "On"] as Row] : []),
      ],
    },
    {
      title: "Tokens",
      rows: [
        ["Input", fmtInt(v.inputTokens)],
        ["Output", fmtInt(v.outputTokens)],
        ["Cache Write", fmtInt(v.cacheCreationTokens)],
        ["Cache Read", fmtInt(v.cacheReadTokens)],
      ],
    },
    {
      title: "Timing",
      rows: [
        ["Total Request Time", fmtTime(v.totalMs)],
        ["API Requests", String(v.requests)],
      ],
    },
    {
      title: "Cost (estimated)",
      rows: [
        ["Latest Interaction", fmtCost(v.costUsd)],
        ["Today", fmtCost(cw.today)],
      ],
    },
  ];

  // One shared right edge across every section's key/value block. A value wider than
  // MAX_VALUE_WIDTH (e.g. a dated model id) is an outlier: it does not widen the shared
  // column, so the numeric rows stay compact and only the outlier's own row overflows.
  const allRows = sections.flatMap((s) => s.rows);
  const kw = Math.max(...allRows.map((r) => r[0].length));
  const vw = Math.max(
    MIN_VALUE_WIDTH,
    ...allRows.map((r) => r[1].length).filter((n) => n <= MAX_VALUE_WIDTH)
  );

  for (const s of sections) {
    L.push("", "---", "");
    L.push(`**${s.title}**`);
    const body = s.rows
      .map(([k, val]) =>
        // A value wider than the column overflows: drop the padding so it is not pushed
        // rightward past the popup's wrap point, keeping it on the label's line.
        val.length > vw
          ? `${k}${GAP}${val}`
          : `${k.padEnd(kw)}${GAP}${val.padStart(vw)}`
      )
      .join("\n");
    L.push("```text\n" + body + "\n```");
  }

  // Action row of command links. Beyond being useful shortcuts, these interactive
  // elements are what make the hover sticky (see the isTrusted note at the top).
  L.push("", "---", "");
  L.push(
    `[$(graph) Open stats tab](command:claudeSpeedometer.togglePanel)` +
      ` · ` +
      `[$(gear) Configure telemetry](command:claudeSpeedometer.configureTelemetry)`
  );

  md.appendMarkdown(L.join("\n"));
  return md;
}
