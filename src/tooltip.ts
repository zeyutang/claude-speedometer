import * as vscode from "vscode";
import { SpeedStore } from "./store";
import {
  fmtAgo,
  fmtCost,
  fmtEffort,
  fmtInt,
  fmtTime,
  fmtTokPerSec,
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
const OUTPUT_MIN_WIDTH = 13; // room for up to 1,000,000,000 (10^9 with commas)

/**
 * The overlay shown when hovering the bolt: a rich Markdown box that pops up just
 * above the status bar (lower-right). Sections render as monospace code blocks
 * sharing one column layout, so values align across every section.
 */
export function buildTooltip(store: SpeedStore): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const now = Date.now();

  const latest = store.getLatest();
  if (!latest) {
    md.appendMarkdown(
      "**Claude Speedometer**\n\nWaiting for the next Claude Code interaction…"
    );
    return md;
  }

  const v = viewOf(latest, now);

  const L: string[] = [];
  L.push(`**Latest interaction** · ${fmtAgo(v.ageMs)}`);
  L.push("");
  L.push(`## ${fmtTokPerSec(v.totalTokPerSec)} tok/s`);
  L.push(`output tokens / total request time`);

  const sections: Section[] = [
    {
      title: "Tokens",
      rows: [
        ["Text Input", fmtInt(v.inputTokens)],
        ["Text Output", fmtInt(v.outputTokens)],
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
      title: "Cost & Model",
      rows: [
        ["Estimated Cost", fmtCost(v.costUsd)],
        ["Model", v.model ?? "-"],
        ["Effort", fmtEffort(v.effort)],
        // Fast mode row appears only when the model supports it and it is on.
        ...(isFastModeOn(v.speed) ? [["Fast mode", "On"] as Row] : []),
      ],
    },
  ];

  // Build Recent up front so its width takes part in the shared layout and so
  // the Output column reserves room for large counts.
  const recent = store.getRecent(6).map((t) => viewOf(t, now));
  const recentHeaders = ["When", "Output", "tok/s", "Total"];
  const recentMin = [0, OUTPUT_MIN_WIDTH, 0, 0];
  const recentRows = recent.map((r) => [
    fmtAgo(r.ageMs),
    fmtInt(r.outputTokens),
    fmtTokPerSec(r.totalTokPerSec),
    fmtTime(r.totalMs),
  ]);

  // One shared right edge across every section (key/value blocks and Recent).
  const allRows = sections.flatMap((s) => s.rows);
  const kw = Math.max(...allRows.map((r) => r[0].length));
  const vwContent = Math.max(
    MIN_VALUE_WIDTH,
    ...allRows.map((r) => r[1].length)
  );
  const kvNatural = kw + GAP.length + vwContent;
  const recentNatural = recentRows.length
    ? tableWidth(recentHeaders, recentRows, recentMin)
    : 0;
  const lineWidth = Math.max(kvNatural, recentNatural);
  const vw = lineWidth - kw - GAP.length;

  for (const s of sections) {
    L.push("", "---", "");
    L.push(`**${s.title}**`);
    const body = s.rows
      .map(([k, val]) => `${k.padEnd(kw)}${GAP}${val.padStart(vw)}`)
      .join("\n");
    L.push("```text\n" + body + "\n```");
  }

  if (recentRows.length) {
    L.push("", "---", "");
    L.push("**Recent**");
    L.push(
      "```text\n" +
        table(recentHeaders, ["l", "r", "r", "r"], recentRows, {
          targetWidth: lineWidth,
          minWidths: recentMin,
        }) +
        "\n```"
    );
  }

  md.appendMarkdown(L.join("\n"));
  return md;
}

const SEP = "   "; // column separator for tables

function colWidths(
  headers: string[],
  rows: string[][],
  minWidths?: number[]
): number[] {
  return headers.map((h, i) =>
    Math.max(h.length, minWidths?.[i] ?? 0, ...rows.map((r) => r[i].length))
  );
}

/** Natural total width of a table (sum of columns plus separators). */
function tableWidth(
  headers: string[],
  rows: string[][],
  minWidths?: number[]
): number {
  const w = colWidths(headers, rows, minWidths);
  return w.reduce((a, b) => a + b, 0) + SEP.length * (headers.length - 1);
}

/** N-column table with per-column left/right alignment and optional minimum
 *  column widths. When targetWidth is given, the last column is widened so the
 *  table's right edge reaches it. */
function table(
  headers: string[],
  align: Array<"l" | "r">,
  rows: string[][],
  opts?: { targetWidth?: number; minWidths?: number[] }
): string {
  const widths = colWidths(headers, rows, opts?.minWidths);
  if (opts?.targetWidth !== undefined) {
    const natural =
      widths.reduce((a, b) => a + b, 0) + SEP.length * (widths.length - 1);
    if (opts.targetWidth > natural) {
      widths[widths.length - 1] += opts.targetWidth - natural;
    }
  }
  const fmtRow = (cells: string[]) =>
    cells
      .map((c, i) =>
        align[i] === "r" ? c.padStart(widths[i]) : c.padEnd(widths[i])
      )
      .join(SEP);
  return [fmtRow(headers), ...rows.map(fmtRow)].join("\n");
}
